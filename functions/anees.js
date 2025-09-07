// functions/anees.js
export default async (req) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return json({ ok:false, error:"Missing GEMINI_API_KEY" }, 500);

    const body = await safeJson(req);
    const { action = "explain", subject = "الفيزياء", concept = "", question = "" } = body || {};
    if (!concept) return json({ ok:false, error:"أدخلي اسم القانون/المفهوم." }, 400);

    const { url, payload } = buildCall(GEMINI_API_KEY, action, subject, concept, question);

    // طلب النموذج
    const r = await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });

    // لو فشل HTTP، نعيد نص واضح بدل Bad JSON
    if (!r.ok) {
      const t = await r.text().catch(()=> "");
      return json({ ok:false, error: `HTTP ${r.status} — ${t.slice(0,200)}` }, r.status);
    }

    const j   = await r.json().catch(()=>null);
    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // --------- محاولات فك JSON (طبقات متعددة) ---------
    let data =
      tryParse(raw) ||
      tryParse(extractJson(raw)) ||
      tryParse(sanitizeJson(extractJson(raw))) ||
      parseLooseJson(raw);

    // إنقاذ خاص لـ practice لو رجع سطر نصي فقط
    if (!data && action === "practice" && typeof raw === "string" && raw.trim()) {
      const only = raw.trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
      // إن كان فقط نص سؤال بلا أقواس
      if (!only.trim().startsWith("{")) {
        data = { question: only.replace(/^["']|["']$/g,'') };
      }
    }

    // محاولة إصلاح ثانية عبر النموذج
    if (!data) {
      const fixPayload = {
        contents: [{
          role:"user",
          parts:[{ text:
`أصلحي JSON التالي ليكون صالحًا 100٪ ويطابق المخطط المطلوب.
أعيدي الكائن فقط بلا أي كودات أو شرح:

${raw}` }]
        }],
        generationConfig:{ temperature:0.2, response_mime_type:"application/json" }
      };
      const rr  = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(fixPayload) });
      if (!rr.ok) {
        const t = await rr.text().catch(()=> "");
        return json({ ok:false, error:`HTTP ${rr.status} أثناء الإصلاح — ${t.slice(0,200)}` }, rr.status);
      }
      const jj  = await rr.json().catch(()=>null);
      const raw2 = jj?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      data =
        tryParse(raw2) ||
        tryParse(extractJson(raw2)) ||
        tryParse(sanitizeJson(extractJson(raw2))) ||
        parseLooseJson(raw2);

      // إنقاذ practice مرة ثانية
      if (!data && action === "practice" && typeof raw2 === "string" && raw2.trim()) {
        const only2 = raw2.trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
        if (!only2.trim().startsWith("{")) {
          data = { question: only2.replace(/^["']|["']$/g,'') };
        }
      }
    }

    if (!data) {
      // نعطي سبب واضح بدل "Bad JSON" فقط
      return json({ ok:false, error:"Bad JSON from model", snippet: (raw||"").slice(0,220) }, 502);
    }

    // --------- تنعيم/ضمان شكل الحمولة ---------
    data = coerceShape(action, data);

    // خطوات: إزالة ترقيم بادئ "1. " إن وجد
    if (Array.isArray(data.steps)) {
      data.steps = data.steps.map(s => (s ?? "").toString().replace(/^\s*\d+[\.\)\-\:]\s*/,'').trim()).filter(Boolean);
    }

    // التفاف آمن للرموز لتفادي startsWith على undefined
    if (Array.isArray(data.symbols)) {
      data.symbols = data.symbols.map(s => wrapSymbol(s));
    }
    if (Array.isArray(data.givens)) {
      data.givens = data.givens.map(g => wrapSymbol(g));
    }
    if (Array.isArray(data.unknowns)) {
      data.unknowns = data.unknowns.map(u => wrapSymbol(u));
    }

    // تحويل أرقام scientific إلى LaTeX حيث يلزم
    tidyPayloadNumbers(data);

    return json({ ok:true, data });

  } catch (e) {
    return json({ ok:false, error: e?.message || "Unexpected error" }, 500);
  }
};

/* ---------- Helpers ---------- */
function json(obj, status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers:{ "Content-Type":"application/json; charset=utf-8" }
  });
}
async function safeJson(req){ try{ return await req.json(); }catch{ return {}; } }
function tryParse(s){ try{ return s && JSON.parse(s); }catch{ return null; } }

function extractJson(text){
  if (!text) return "";
  let t = (text+"")
    .replace(/\uFEFF/g,"")
    .replace(/[\u200E\u200F\u202A-\u202E]/g,"")
    .trim()
    .replace(/^```json/i,"```")
    .replace(/^```/,"")
    .replace(/```$/,"")
    .trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a>=0 && b>a) t = t.slice(a, b+1);
  return t;
}
function sanitizeJson(t){
  return (t||"")
    .replace(/[“”]/g,'"')
    .replace(/[‘’]/g,"'")
    .replace(/,\s*([}\]])/g,"$1")
    .replace(/:\s*undefined/g,": null")
    .replace(/\s+\n/g,"\n")
    .trim();
}

// اقتباس مفاتيح غير مقتبسة إن وُجدت + تنظيف Markdown بسيط
function parseLooseJson(s){
  if(!s) return null;
  let t = extractJson(s);
  if(!t) return null;
  t = t.replace(/([{,]\s*)([A-Za-z\u0600-\u06FF_][\w\u0600-\u06FF_]*)(\s*):/g, '$1"$2"$3:'); // "key":
  try { return JSON.parse(t); } catch { return null; }
}

// لفّ الرمز بدولارين إن لم يكن ملفوفًا
function wrapSymbol(x){
  const sym = (((x||{}).symbol) ?? '') + '';
  const wrapped = sym && /^\$.*\$$/.test(sym) ? sym : (sym ? `$${sym}$` : sym);
  return { ...x, symbol: wrapped };
}

function sciToLatex(v){
  const s = (v??"")+"";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if(!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/,"$1$2");
  const exp = parseInt(m[2],10);
  return `$${mant}\\times10^{${exp}}$`;
}
function tidyPayloadNumbers(obj){
  const fix = (x)=> {
    if (typeof x === "number") return sciToLatex(x);
    if (/^\s*[+-]?\d+(\.\d+)?e[+-]?\d+\s*$/i.test((x||"")+"")) return sciToLatex(x);
    return x;
  };
  if (Array.isArray(obj.givens))   obj.givens   = obj.givens.map(g => ({ ...g, value: fix(g.value) }));
  if (Array.isArray(obj.unknowns)) obj.unknowns = obj.unknowns.map(u => ({ ...u }));
}

// ضمان الشكل المتوقع بحسب نوع الإجراء، حتى لو نسي النموذج حقولًا
function coerceShape(action, obj){
  const safeStr = v => (typeof v === 'string' ? v : (v==null ? '' : String(v)));
  const safeArr = a => Array.isArray(a) ? a : [];
  if (action === 'explain') {
    return {
      title:    safeStr(obj.title),
      overview: safeStr(obj.overview),
      symbols:  safeArr(obj.symbols).map(x => ({
        desc:  safeStr(x?.desc),
        symbol:safeStr(x?.symbol),
        unit:  safeStr(x?.unit)
      })),
      formulas: safeArr(obj.formulas).map(safeStr),
      steps:    safeArr(obj.steps).map(safeStr)
    };
  }
  if (action === 'practice') {
    return { question: safeStr(obj.question || obj.prompt || obj.text || '') };
  }
  // example / example2 / solve
  return {
    scenario: safeStr(obj.scenario || obj.question || ''),
    givens:   safeArr(obj.givens).map(x => ({
      symbol: safeStr(x?.symbol),
      value:  safeStr(x?.value),
      unit:   safeStr(x?.unit),
      desc:   safeStr(x?.desc)
    })),
    unknowns: safeArr(obj.unknowns).map(x => ({
      symbol: safeStr(x?.symbol),
      desc:   safeStr(x?.desc)
    })),
    formulas: safeArr(obj.formulas || (obj.formula ? [obj.formula] : [])).map(safeStr),
    steps:    safeArr(obj.steps).map(safeStr),
    result:   safeStr(obj.result)
  };
}

function buildCall(key, action, subject, concept, question){
  const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;

  const header =
`أنت خبيرة ${subject}.
اكتبي بالعربية الفصحى فقط.
المعادلات بالـ LaTeX بين $...$ أو $$...$$.
الوحدات داخل \\mathrm{} مثل: $9.8\\,\\mathrm{m/s^2}$.
أعد دائمًا "JSON صالح فقط" بلا أي شرح خارج الكائن.
المفهوم: «${concept}».`;

  const explainSchema = {
    title: "عنوان قصير",
    overview: "تعريف موجز واضح بالعربية",
    symbols: [
      { desc:"القوة", symbol:"F", unit:"\\mathrm{N}" }
    ],
    formulas: ["$$F=ma$$"],
    steps: ["١- استخراج المعطيات","٢- اختيار القانون","٣- التعويض والحساب"]
  };

  const exampleSchema = {
    scenario: "نص مسألة عددية حقيقية وواضحة",
    givens: [ { symbol:"m", value:"5", unit:"\\mathrm{kg}", desc:"الكتلة" } ],
    unknowns: [ { symbol:"a", desc:"التسارع" } ],
    formulas: ["$$F=ma$$"],
    steps: ["اشرح خطوات الحل بالتفصيل مع التعويض العددي في كل خطوة إن أمكن. لا تضع أرقامًا للخطوات في النص نفسه."],
    result: "$$a = 2\\,\\mathrm{m/s^2}$$"
  };

  let temp = 0.2;
  let prompt = header;

  if (action === "explain") {
    prompt += `
أعِد JSON يطابق هذا المخطط حرفيًا مع توسيعه بما يلزم:
${JSON.stringify(explainSchema)}
- لا تستخدم الإنجليزية في الشرح.
- لا تكتب \\mathrm في النص العادي (فقط داخل المعادلات).
- اجعل جدول الرموز مصفوفة كائنات: [{ "desc","symbol","unit" }].`;
  } else if (action === "example") {
    temp = 0.35;
    prompt += `
أعِد JSON يمثل مثالًا تطبيقيًا بصعوبة "متوسطة" حول «${concept}».
يجب أن يملأ هذا المخطط (مسموح التغيير في القيم فقط):
${JSON.stringify(exampleSchema)}
- اكتب القيم بالأرقام العادية (مثل 0.002 وليس 2e-3).
- لا تكتب عبارة "سؤال صحيح وواضح".
- اجعل خطوات الحل مفصلة وتشرح عملية التعويض العددي.`;
  } else if (action === "example2") {
    temp = 0.5;
    prompt += `
أعِد JSON يمثل مثالًا آخر "أصعب بقليل" من المثال الأول، وبمجهول مختلف.
النموذج:
${JSON.stringify(exampleSchema)}
- غيّر المجهول (مثلاً من a إلى m أو F).
- لا تستخدم الصيغة العلمية 1e3؛ اكتب 1000.
- بدون أي نص خارج JSON.
- اجعل خطوات الحل مفصلة وتشرح عملية التعويض العددي.`;
  } else if (action === "practice") {
    temp = 0.55;
    prompt += `
أعِد JSON بهذا الشكل فقط:
{ "question": "<سؤال عربي عددي كامل حول «${concept}» بصياغة سليمة وواضحة، مستوى صعوبة متوسط، مع أرقام ووحدات حقيقية داخل LaTeX عند الحاجة>" }
- لا تكرر نفس المجهول في كل مرة؛ نوع بين (السرعة، التسارع، الكتلة، القوة، الزمن، الارتفاع، الشحنة...) حسب المفهوم.
- لا تضع أي مفاتيح أخرى.
- لا تكتب الإنجليزية مطلقًا.`;
  } else if (action === "solve") {
    temp = 0.25;
    prompt += `
حل المسألة التالية بنفس شكل المثال (givens/unknowns/formulas/steps/result):
السؤال: ${question}
- رتّب givens/unknowns بدقة ووحدات صحيحة.
- أظهر في Steps الخطوات بالتفصيل مع التعويض العددي، وأي معادلة داخل $...$ أو $$...$$.
- ضع النتيجة النهائية في "result" بصيغة LaTeX مع الوحدة.
- القيم بالأرقام العادية (بدون 1e3).`;
  }

  const payload = {
    contents:[{ role:"user", parts:[{ text: prompt }]}],
    generationConfig:{
      temperature: temp,
      topP: 0.9,
      candidateCount: 1,
      maxOutputTokens: 1100,          // هام لتفادي قصّ JSON
      response_mime_type:"application/json",
      stopSequences:["```","\n\n\n"]  // تقليل كودات ماركداون
    }
  };

  return { url: baseUrl, payload };
}
