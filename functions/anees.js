// functions/anees.js
export default async (req) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return J({ ok:false, error:"Missing GEMINI_API_KEY" }, 500);

    const body = await safeJson(req);
    const { action = "explain", subject = "الفيزياء", concept = "", question = "" } = body || {};
    if (!concept) return J({ ok:false, error:"أدخلي اسم القانون/المفهوم." }, 400);

    // ====== بناء الطلب الأساسي ======
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = buildPrompt(action, subject, concept, question);
    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 900,
        response_mime_type: "application/json"
      }
    };

    // ====== نداء أول ======
    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    const j = await r.json().catch(()=>null);
    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    // نحاول القراءة بعدة طرق
    let data = tryParse(raw) || tryParse(extractJson(raw)) || tryParse(sanitizeJson(extractJson(raw)));

    // ====== خطة إنقاذ: نرسل للنموذج نفسه ليُصلح JSON ======
    if (!data) {
      const fixPayload = {
        contents: [{
          role:"user",
          parts:[{
            text:
`أصلحي JSON التالي ليكون صالحًا 100٪ ويطابق المخطط المطلوب. أعيدي كائن JSON فقط بلا أي شرح.
${raw}`
          }]
        }],
        generationConfig: { temperature: 0.2, response_mime_type: "application/json" }
      };
      const rr = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(fixPayload) });
      const jj = await rr.json().catch(()=>null);
      const raw2 = jj?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      data = tryParse(raw2) || tryParse(extractJson(raw2)) || tryParse(sanitizeJson(extractJson(raw2)));
    }

    if (!data) return J({ ok:false, error:"Bad JSON from model" }, 502);

    // ====== تحسينات شكلية قبل الإرسال للواجهة ======
    if (Array.isArray(data.steps)) {
      data.steps = data.steps.map(s => (s || "").toString().replace(/^\s*\d+[\)\.\-]\s*/,'').trim());
    }
    wrapSymbols(data, ['symbols','givens','unknowns']);     // نضمن $m_1$ … إلخ
    tidyPayloadNumbers(data);                                // نحول 1e5 إلى a×10^n لايتك

    return J({ ok:true, data });
  } catch (err) {
    return J({ ok:false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ================= Helpers ================= */
function J(obj, status=200){
  return new Response(JSON.stringify(obj), { status, headers:{ "Content-Type":"application/json; charset=utf-8" }});
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
    .trim();
}

// نضمن أن الرموز ملفوفة بـ $...$ عند الحاجة
function wrapSymbols(obj, keys){
  const needsWrap = v => typeof v === 'string' && !/^\s*\$.*\$\s*$/.test(v);
  keys.forEach(k=>{
    if (!Array.isArray(obj[k])) return;
    obj[k] = obj[k].map(row=>{
      const copy = { ...row };
      if (copy.symbol && needsWrap(copy.symbol)) copy.symbol = `$${copy.symbol}$`;
      return copy;
    });
  });
}

// تحويل 1e5 → $1\times10^{5}$
function sciToLatex(v){
  const s = (v??"")+"";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if(!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/,"$1$2");
  const exp = parseInt(m[2],10);
  return `$${mant}\\times10^{${exp}}$`;
}
function tidyPayloadNumbers(obj){
  const fixVal = (x)=>{
    if (typeof x === "number") return sciToLatex(x);
    const sx = (x||"")+"";
    if (/^\s*[+-]?\d+(\.\d+)?e[+-]?\d+\s*$/i.test(sx)) return sciToLatex(sx);
    return x;
  };
  if (Array.isArray(obj.givens)) obj.givens = obj.givens.map(g => ({ ...g, value: fixVal(g.value) }));
  if (Array.isArray(obj.unknowns)) obj.unknowns = obj.unknowns.map(u => ({ ...u, value: fixVal(u.value) }));
}

/* ================= Prompt Builder ================= */
function buildPrompt(action, subject, concept, question){
  const BASE =
`أنت خبيرة ${subject}.
اكتبي بالعربية الفصحى فقط (ممنوع الإنجليزية).
التزمي STRICTLY بالمفهوم المطلوب: «${concept}» فقط.
اكتبي الوحدات داخل \\mathrm{...} حصراً: \\mathrm{N}, \\mathrm{kg}, \\mathrm{m/s^2} …
استخدمي LaTeX داخل $...$ أو $$...$$ للرموز والمعادلات.
ممنوع ترميز e-notation، استخدمي الشكل $a\\times10^{n}$ إذا لزم.
أعيدي كائن JSON صالح فقط بدون أي شرح أو زخرفة.`;

  const EXPLAIN_SCHEMA = `{"title":"string","overview":"string","symbols":[{"desc":"string","symbol":"string","unit":"string"}],"formulas":["string"],"steps":["string"]}`;
  const EXAMPLE_SCHEMA = `{"scenario":"string","givens":[{"symbol":"string","value":"string","unit":"string","desc":"string"}],"unknowns":[{"symbol":"string","desc":"string"}],"formula":"string","steps":["string"],"result":"string"}`;
  const PRACTICE_SCHEMA = `{"question":"string"}`;

  if (action === "explain"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${EXPLAIN_SCHEMA}
- اجعلي "formulas" خاصة بـ «${concept}».
- اجعلي "symbols": (desc عربي، symbol مثل m أو v_f، unit داخل \\mathrm{...}).
- "steps": عناصر مستقلة بلا ترقيم آلي (واحد لكل خطوة).`;
  }
  if (action === "example"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${EXAMPLE_SCHEMA}
المستوى: متوسط. اختاري مجهولًا مناسبًا واحدًا من متغيرات «${concept}».
القيم منطقية ووحدات صحيحة. المعادلات داخل $...$. كل خطوة في عنصر مستقل.`;
  }
  if (action === "example2"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${EXAMPLE_SCHEMA}
المستوى: فوق المتوسط بدرجة. اختاري مجهولًا مختلفًا عن المثال الشائع لنفس «${concept}».
التزمي بالقانون الصحيح فقط. كل خطوة في عنصر مستقل.`;
  }
  if (action === "practice"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${PRACTICE_SCHEMA}
أنتج سؤال تدريب عربي (2–3 جُمل) بمستوى "متوسط" مع أعداد ووحدات صحيحة بصيغة LaTeX.
غيّري السيناريو والمجهول في كل مرة. بدون حل.`;
  }
  if (action === "solve"){
    return `${BASE}
حلّي المسألة التالية وأعيدي JSON يطابق مخطط المثال: ${EXAMPLE_SCHEMA}
السؤال: ${question}
- رتّبي givens/unknowns بدقة ووحدات صحيحة.
- Steps بالعربية، والمعادلات داخل $...$.
- النتيجة النهائية داخل "result" بصيغة LaTeX مع الوحدة.`;
  }
  return `${BASE}{"error":"unknown action"}`;
}
