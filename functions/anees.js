// functions/anees.js
export default async (req) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return send({ ok:false, error:"Missing GEMINI_API_KEY" }, 500);

    const body = await safeJson(req);
    const { action="explain", subject="الفيزياء", concept="", question="" } = body || {};
    if (!concept) return send({ ok:false, error:"أدخلي اسم القانون/المفهوم." }, 400);

    const prompt = buildPrompt(action, subject, concept, question);
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key="+GEMINI_API_KEY;

    // ✅ المفتاح الصحيح: responseMimeType
    const basePayload = {
      contents: [{ role:"user", parts:[{ text: prompt }]}],
      generationConfig: {
        temperature: 0.1,
        topP: 0.9,
        maxOutputTokens: 1200,
        responseMimeType: "application/json"
      }
    };

    // --- الطلب الأول
    let raw = await callGemini(url, basePayload);
    let data = parseAsJson(raw);

    // --- محاولة إصلاح عبر طلب ثانٍ إن لزم
    if (!data) {
      const repairPayload = {
        contents: [{
          role: "user",
          parts: [{
            text: "حوّلي النص التالي إلى JSON صالح 100% يطابق المخطط المطلوب تمامًا. " +
                  "أعيدي الكائن فقط بدون أي نص خارج الأقواس وبدون Markdown.\n\n" + raw
          }]
        }],
        generationConfig: { temperature: 0.05, responseMimeType: "application/json", maxOutputTokens: 1200 }
      };
      raw = await callGemini(url, repairPayload);
      data = parseAsJson(raw);
    }

    // --- استخراج/تنظيف محلي أخير
    if (!data) {
      const extracted = extractJson(raw);
      data = parseAsJson(extracted) || parseAsJson(sanitizeJson(extracted));
    }

    if (!data) {
      return send({ ok:false, error:"Bad JSON from model", snippet:(raw||"").slice(0,400) }, 502);
    }

    // تنعيم الحقول
    if (Array.isArray(data.steps)) {
      data.steps = data.steps
        .map(s => (s||"").toString().replace(/^\s*\d+[\).\-\:]\s*/,"").trim())
        .filter(Boolean);
    }
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
    headers: { "Content-Type":"application/json; charset=utf-8", "Access-Control-Allow-Origin":"*" }
  });
}

async function safeJson(req){ try{ return await req.json(); }catch{ return {}; } }

async function callGemini(url, payload){
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
  if (!r.ok){ const t = await r.text().catch(()=> ""); throw new Error(`HTTP ${r.status} — ${t.slice(0,200)}`); }
  const j = await r.json().catch(()=> null);
  return j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

function parseAsJson(s){
  try{
    if (!s) return null;
    let t = (s+"").trim();
    t = t.replace(/^```json/i,"```").replace(/^```/,"").replace(/```$/,"").trim();
    return JSON.parse(t);
  }catch{ return null; }
}

function extractJson(text){
  if (!text) return "";
  let t = (text+"")
    .replace(/\uFEFF/g,"")
    .replace(/[\u200E\u200F\u202A-\u202E]/g,"")
    .trim()
    .replace(/^```json/i,"```").replace(/^```/,"").replace(/```$/,"").trim();
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
    .trim();
}

// 1.23e+4 → $1.23\times10^{4}$
function sciToLatex(v){
  const s = (v??"")+"";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if (!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/,"$1$2");
  const exp = parseInt(m[2],10);
  return `$${mant}\\times10^{${exp}}$`;
}

function fixSciNumbers(obj){
  const fix = x => {
    if (typeof x === "number") return sciToLatex(x);
    const sx = (x??"")+"";
    if (/^\s*[+-]?\d+(\.\d+)?e[+-]?\d+\s*$/i.test(sx)) return sciToLatex(sx);
    return x;
  };
  if (Array.isArray(obj.givens)) obj.givens   = obj.givens  .map(g => ({ ...g, value: fix(g.value) }));
  if (Array.isArray(obj.unknowns)) obj.unknowns = obj.unknowns.map(u => ({ ...u, value: fix(u.value) }));
}

function wrapLatexSymbols(obj, fields){
  fields.forEach(f=>{
    const arr = obj[f]; if (!Array.isArray(arr)) return;
    obj[f] = arr.map(it=>{
      const sym = (it?.symbol??"")+"";
      const has = /^\$.*\$$/.test(sym);
      return { ...it, symbol: has ? sym : (sym ? `$${sym}$` : sym) };
    });
  });
}

/* --------------- Prompt Builder --------------- */
function buildPrompt(action, subject, concept, question){
  const BASE = `أنت خبيرة ${subject}.
اكتبي بالعربية الفصحى فقط.
التزمي STRICTLY بالمفهوم المطلوب: «${concept}».
اكتبي الوحدات داخل \\mathrm{...}: \\mathrm{N}, \\mathrm{kg}, \\mathrm{m/s^2}.
استخدمي LaTeX داخل $...$ أو $$...$$.
القيم العلمية بصيغة a\\times10^{n} وليس e-notation.
أعيدي كائن JSON صالحًا فقط بدون أي نص خارجه.

المخططات المقبولة:
- explain: {"title":"string","overview":"string","symbols":[{"desc":"string","symbol":"string","unit":"string"}],"formulas":["string"],"steps":["string"]}
- example/example2/solve: {"scenario":"string","givens":[{"symbol":"string","value":"string","unit":"string","desc":"string"}],"unknowns":[{"symbol":"string","desc":"string"}],"formula":"string","steps":["string"],"result":"string"}
- practice: {"question":"string"}`;

  if (action==="explain") return `${BASE}
أعيدي JSON لحالة explain فقط. ركّزي على «${concept}».`;
  if (action==="example") return `${BASE}
أعيدي JSON لحالة example بقيم منطقية ومجهول مناسب من «${concept}».`;
  if (action==="example2") return `${BASE}
أعيدي JSON لحالة example2 بمجهول مختلف لنفس «${concept}».`;
  if (action==="practice") return `${BASE}
أعيدي JSON لحالة practice بسؤال من 2–3 جمل مع أعداد ووحدات بـ LaTeX.`;
  if (action==="solve") return `${BASE}
أعيدي JSON لحالة solve لهذه المسألة:
${question}
مع نتيجة نهائية في "result" بـ LaTeX + الوحدة.`;

  return `${BASE}\n{"error":"unknown action"}`;
}
