// functions/anees.js
export default async (req) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return json({ ok:false, error:"Missing GEMINI_API_KEY" }, 500);

    const body = await safeJson(req);
    const { action = "explain", subject = "الفيزياء", concept = "", question = "" } = body || {};
    if (!concept) return json({ ok:false, error:"أدخلي اسم القانون/المفهوم." }, 400);

    const { url, payload } = buildCall(GEMINI_API_KEY, action, subject, concept, question);

    // ← استخدام postWithRetry بدل fetch المباشر
    const j = await postWithRetry(url, payload).catch(err => {
      return { __http_error: String(err.message || err) };
    });
    if (j && j.__http_error) {
      return json({ ok:false, error: j.__http_error }, 429);
    }

    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    let data =
      tryParse(raw) ||
      tryParse(extractJson(raw)) ||
      tryParse(sanitizeJson(extractJson(raw))) ||
      parseLooseJson(raw);

    if (!data) {
      const fixPayload = {
        contents: [{ role:"user", parts:[{ text:
`أصلحي JSON التالي ليكون صالحًا 100٪ ويطابق المخطط المطلوب.
أعيدي الكائن فقط بلا أي كودات أو شرح:

${raw}` }]}],
        generationConfig:{ temperature:0.2, response_mime_type:"application/json" }
      };

      const jj = await postWithRetry(url, fixPayload).catch(err => {
        return { __http_error: String(err.message || err) };
      });
      if (jj && jj.__http_error) {
        return json({ ok:false, error: jj.__http_error }, 429);
      }

      const raw2 = jj?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      data =
        tryParse(raw2) ||
        tryParse(extractJson(raw2)) ||
        tryParse(sanitizeJson(extractJson(raw2))) ||
        parseLooseJson(raw2);
    }

    if (!data) return json({ ok:false, error:"Bad JSON from model" }, 502);

    // معالجة الرموز والترقيم
    if (data.steps) {
      data.steps = data.steps.map(s => (s ?? "").toString().replace(/^\s*\d+\.\s*/, '').trim());
    }

    const wrapSym = (sym) => {
      sym = (sym ?? '') + '';
      return sym && /^\$.*\$$/.test(sym) ? sym : (sym ? `$${sym}$` : sym);
    };

    if (data.symbols) {
      data.symbols = data.symbols.map(s => ({ ...s, symbol: wrapSym(s?.symbol) }));
    }
    if (data.givens) {
      data.givens = data.givens.map(g => ({ ...g, symbol: wrapSym(g?.symbol) }));
    }
    if (data.unknowns) {
      data.unknowns = data.unknowns.map(u => ({ ...u, symbol: wrapSym(u?.symbol) }));
    }

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
function parseLooseJson(s){
  if(!s) return null;
  let t = extractJson(s);
  if(!t) return null;
  t = t.replace(/([{,]\s*)([A-Za-z\u0600-\u06FF_][\w\u0600-\u06FF_]*)(\s*):/g, '$1"$2"$3:');
  try { return JSON.parse(t); } catch { return null; }
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

// إعادة المحاولة مع backoff
async function postWithRetry(url, payload, { tries = 3, baseDelayMs = 800 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(payload)
      });
      if (r.status === 429 || r.status === 503) {
        const t = await r.text().catch(()=> "");
        lastErr = new Error(`HTTP ${r.status} — ${t.slice(0,200)}`);
      } else if (!r.ok) {
        const t = await r.text().catch(()=> "");
        throw new Error(`HTTP ${r.status} — ${t.slice(0,200)}`);
      } else {
        return await r.json();
      }
    } catch (e) {
      lastErr = e;
    }
    const wait = baseDelayMs * Math.pow(2, i);
    await new Promise(res => setTimeout(res, wait));
  }
  throw lastErr || new Error("Request failed");
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
    symbols: [ { desc:"القوة", symbol:"F", unit:"\\mathrm{N}" } ],
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
    generationConfig:{ temperature: temp, maxOutputTokens: 900, response_mime_type:"application/json" }
  };

  return { url: baseUrl, payload };
}
