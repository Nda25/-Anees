// functions/anees.js
exports.handler = async (event) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return json({ ok:false, error:"Missing GEMINI_API_KEY" }, 500);

const body = safeJson(event.body);
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
  return {
    statusCode: status,
    headers:{ "Content-Type":"application/json; charset=utf-8" },
    body: JSON.stringify(obj)
  };
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
  const baseUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `gemini-1.5-flash:generateContent?key=${key}`;

  // قواعد عامة ثابتة لكل الطلبات
  const RULES = `
- اكتب **بالعربية الفصحى فقط** في كل الحقول النصية (scenario/overview/steps/…).
- يمنع استخدام الإنجليزية خارج LaTeX مطلقًا؛ إن كان السؤال أو المصطلحات إنجليزية فترجمها للعربية.
- المعادلات دائمًا داخل $...$ أو $$...$$ فقط.
- الوحدات داخل LaTeX وبصيغة \\mathrm{...} مثل: $9.8\\,\\mathrm{m/s^2}$.
- لا تضع أي Markdown أو \`\`\` أو تعليقات؛ **أعيد JSON صالح فقط**.
- المفاتيح المسموحة حسب نوع الطلب ولا غيرها.`;

  // مخططات صارمة نلزم بها النموذج
  const EXPLAIN_SCHEMA = {
    title: "عنوان قصير بالعربية",
    overview: "تعريف موجز واضح بالعربية",
    symbols: [ { desc:"القوة", symbol:"F", unit:"\\mathrm{N}" } ],
    formulas: ["$$F=ma$$"],
    steps: ["استخراج المعطيات","اختيار القانون","التعويض والحساب"]
  };

  const EXAMPLE_SCHEMA = {
    scenario: "نص مسألة عربية واضحة",
    givens:   [ { symbol:"m", value:"5", unit:"\\mathrm{kg}", desc:"الكتلة" } ],
    unknowns: [ { symbol:"a", desc:"التسارع" } ],
    formulas: ["$$F=ma$$"],
    steps:    ["خطوات عربية مفصلة مع التعويض العددي في كل خطوة"],
    result:   "$$a = 2\\,\\mathrm{m/s^2}$$"
  };

  let temp = 0.25;
  let prompt = `أنت خبيرة ${subject}. ${RULES}
المفهوم: «${concept}».`;

  if (action === "explain") {
    prompt += `
أعِد كائن JSON **يطابق حرفيًا** هذا المخطط (القيم فقط تتغير):
${JSON.stringify(EXPLAIN_SCHEMA)}
- اجعل جميع الحقول بالعربية فقط.
- لا تستخدم \\mathrm في النص العادي (فقط داخل المعادلات).`;
    temp = 0.2;

  } else if (action === "example") {
    prompt += `
أعد مثالًا تطبيقيًا “متوسط الصعوبة” حول «${concept}» وفق هذا المخطط:
${JSON.stringify(EXAMPLE_SCHEMA)}
- عدّل الأرقام والقيم فقط، واحرص على أن تكون وحدات givens داخل \\mathrm.
- steps عربية بالكامل وتشرح التعويض العددي خطوة بخطوة.
- ممنوع الصيغة العلمية 1e3؛ اكتب 1000.`;
    temp = 0.35;

  } else if (action === "example2") {
    prompt += `
أعد مثالًا آخر “أصعب قليلًا” وبمجهول مختلف، طبقًا للمخطط نفسه:
${JSON.stringify(EXAMPLE_SCHEMA)}
- غيّر المجهول في unknowns (مثلًا من a إلى m أو F).
- steps عربية فقط وتحتوي معادلات داخل $...$.
- بدون أي نص خارج JSON.`;
    temp = 0.45;

  } else if (action === "practice") {
    prompt += `
أعِد JSON بهذا الشكل فقط:
{ "question": "<سؤال عربي عددي كامل وواضح حول «${concept}»، بمستوى متوسط، مع وحدات حقيقية داخل LaTeX عند الحاجة>" }
- لا تضف أي مفاتيح أخرى.`;
    temp = 0.55;

  } else if (action === "solve") {
    // نُلزم النموذج بنفس مخطط المثال لضمان تعبئة الجدول
    prompt += `
حل المسألة التالية وأعد JSON **بنفس مخطط المثال تمامًا**:
السؤال: ${question}

يجب أن يكون الناتج بالكائن التالي (غيّر القيم فقط):
${JSON.stringify(EXAMPLE_SCHEMA)}

التعليمات الإلزامية:
- املأ givens و unknowns بدقة (symbol قصير مثل m, a, F) و unit داخل \\mathrm فقط.
- steps عربية مفصلة؛ أي معادلة داخل $...$ أو $$...$$؛ لا تكتب \\mathrm في النص العادي.
- ضع النتيجة النهائية في "result" بصيغة LaTeX مع وحدة صحيحة.`;
    temp = 0.25;

  } else {
    // افتراضي: عاملِه كشرح
    prompt += `
(وضع افتراضي explain)
${JSON.stringify(EXPLAIN_SCHEMA)}`;
    temp = 0.25;
  }

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: {
      temperature: temp,
      maxOutputTokens: 900,
      response_mime_type: "application/json"
    }
  };

  return { url: baseUrl, payload };
}
