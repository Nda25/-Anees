// functions/anees.js
export default async (req) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return send({ ok:false, error:"Missing GEMINI_API_KEY" }, 500);

    const body = await safeJson(req);
    const { action="explain", subject="الفيزياء", concept="", question="" } = body || {};
    if (!concept) return send({ ok:false, error:"أدخلي اسم القانون/المفهوم." }, 400);

    // --------- مخططات صارمة لكل أكشن (Schema) ----------
    const SCHEMAS = {
      explain: {
        type: "object",
        required: ["title","overview","symbols","formulas","steps"],
        properties: {
          title: { type: "string" },
          overview: { type: "string" },
          symbols: {
            type: "array",
            items: {
              type: "object",
              required: ["desc","symbol","unit"],
              properties: {
                desc:   { type: "string" },
                symbol: { type: "string" },
                unit:   { type: "string" }
              }
            }
          },
          formulas: { type: "array", items: { type: "string" } },
          steps:    { type: "array", items: { type: "string" } }
        }
      },
      example: baseCaseSchema(),
      example2: baseCaseSchema(),
      solve:    baseCaseSchema(),
      practice: {
        type: "object",
        required: ["question"],
        properties: { question: { type: "string" } }
      }
    };

    function baseCaseSchema(){
      return {
        type: "object",
        required: ["scenario","givens","unknowns","formula","steps","result"],
        properties: {
          scenario: { type: "string" },
          givens: {
            type: "array",
            items: {
              type: "object",
              required: ["symbol","value","unit","desc"],
              properties: {
                symbol: { type: "string" },
                value:  { type: "string" },
                unit:   { type: "string" },
                desc:   { type: "string" }
              }
            }
          },
          unknowns: {
            type: "array",
            items: {
              type: "object",
              required: ["symbol","desc"],
              properties: {
                symbol: { type: "string" },
                desc:   { type: "string" }
              }
            }
          },
          formula: { type: "string" },
          steps:   { type: "array", items: { type: "string" } },
          result:  { type: "string" }
        }
      };
    }

    // --------- بناء البرومبت (مُقيَّد) ----------
    const prompt = buildPrompt(action, subject, concept, question);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

    // نسلّم للموديل مخطط الاستجابة ليفرض JSON صالح
    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1200,
        response_mime_type: "application/json",
        response_schema: SCHEMAS[action] || SCHEMAS.explain
      }
    };

    const raw = await callGemini(url, payload);

    const data = parseAsJson(raw); // يجب أن ينجح بسبب الـ schema
    if (!data) {
      // لو لأي سبب فشل، أظهر جزء من النص للمساعدة
      return send({ ok:false, error:"Bad JSON from model", snippet: String(raw).slice(0,400) }, 502);
    }

    // تنظيف خفيف
    if (Array.isArray(data.steps))
      data.steps = data.steps.map(s => String(s||'').replace(/^\s*\d+[\).\-\:]\s*/, '').trim()).filter(Boolean);

    wrapLatexSymbols(data, ["symbols","givens","unknowns"]);
    fixSciNumbers(data);

    return send({ ok:true, data });

  } catch (err) {
    return send({ ok:false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ----------------- Helpers ----------------- */
function send(obj, status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type":"application/json; charset=utf-8" }
  });
}

async function safeJson(req){ try{ return await req.json(); } catch{ return {}; } }

async function callGemini(url, payload){
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=>null);
  if (!r.ok) {
    const msg = j?.error?.message || (`HTTP ${r.status}`);
    throw new Error(msg);
  }
  // Gemini يعيد النص في parts[0].text بصيغة JSON (لأننا فرضنا schema)
  return j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

function parseAsJson(s){
  try {
    if (!s) return null;
    let t = (s+"").trim();
    t = t.replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();
    return JSON.parse(t);
  } catch { return null; }
}

function sciToLatex(v){
  const s = (v ?? "") + "";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if (!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/, "$1$2");
  const exp = parseInt(m[2],10);
  return `$${mant}\\times10^{${exp}}$`;
}
function fixSciNumbers(obj){
  const fix = x=>{
    if (typeof x === "number") return sciToLatex(x);
    const s = (x??"")+"";
    return /^\s*[+-]?\d+(\.\d+)?e[+-]?\d+\s*$/i.test(s) ? sciToLatex(s) : x;
  };
  if (Array.isArray(obj.givens))   obj.givens   = obj.givens.map(g => ({ ...g, value: fix(g.value) }));
  if (Array.isArray(obj.unknowns)) obj.unknowns = obj.unknowns.map(u => ({ ...u, value: fix(u.value) }));
}
function wrapLatexSymbols(obj, fields){
  fields.forEach(f=>{
    const arr = obj[f];
    if (!Array.isArray(arr)) return;
    obj[f] = arr.map(it=>{
      const sym = (it?.symbol ?? "") + "";
      const has = /^\$.*\$$/.test(sym);
      return { ...it, symbol: has ? sym : (sym ? `$${sym}$` : sym) };
    });
  });
}

/* --------------- Prompt Builder --------------- */
function buildPrompt(action, subject, concept, question){
  const BASE =
`أنت خبيرة ${subject}.
اكتبي بالعربية فقط.
التزمي بالمفهوم: «${concept}».
استخدمي LaTeX داخل $...$ أو $$...$$ للمعادلات والرموز.
القيم العلمية بصيغة a\\times10^{n} وليس e-notation.
الوحدات داخل \\mathrm{...} (مثال: \\mathrm{N}, \\mathrm{kg}, \\mathrm{m/s^2}).
أعيدي JSON فقط دون أي نص آخر.`;

  if (action === "explain")
    return `${BASE}
أعيدي: {"title","overview","symbols","formulas","steps"}.
"symbols": عناصر {desc,symbol,unit}.`;

  if (action === "example")
    return `${BASE}
أعيدي: {"scenario","givens","unknowns","formula","steps","result"}.
اختاري مجهولًا منطقيًا مرتبطًا بـ «${concept}».`;

  if (action === "example2")
    return `${BASE}
أعيدي: {"scenario","givens","unknowns","formula","steps","result"}.
اختاري مجهولًا مختلفًا عن المثال الأول لنفس «${concept}».`;

  if (action === "practice")
    return `${BASE}
أعيدي: {"question"} فقط. اطرحي مسألة تدريب من 2–3 جمل.`;

  if (action === "solve")
    return `${BASE}
أعيدي: {"scenario","givens","unknowns","formula","steps","result"}.
حلّي السؤال التالي:
${question}`;

  return BASE;
}
