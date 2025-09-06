// functions/anees.js
export default async (req) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return json({ ok:false, error:"Missing GEMINI_API_KEY" }, 500);

    const body = await safeJson(req);
    const { action, subject="الفيزياء", concept="", question="" } = body || {};
    if (!concept) return json({ ok:false, error:"أدخلي اسم القانون/المفهوم." }, 400);

    const prompt = buildPrompt(action, subject, concept, question);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [{ role:"user", parts:[{ text: prompt }]}],
      generationConfig:{
        // تنويع بسيط، بدون ما يأثر على الثبات
        temperature: action==="practice" ? 0.6 : action==="example2" ? 0.5 : 0.35,
        maxOutputTokens: 950,
        response_mime_type: "application/json"
      }
    };

    // ====== الطلب الأساسي
    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    const j = await r.json().catch(()=>null);

    const raw =
      j?.candidates?.[0]?.content?.parts?.[0]?.text ??
      j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ??
      "";

    // نحاول 1) JSON مباشر 2) استخراج من بين الرموز 3) إصلاح محلي 4) إصلاح عبر Gemini
    let data =
      tryParseJson(raw) ||
      tryParseJson(extractJson(raw)) ||
      tryParseJson(sanitizeJson(extractJson(raw))) ||
      null;

    if (!data) {
      // إصلاح عبر Gemini: “أعيدي الكائن فقط”
      const fixPayload = {
        contents: [{ role:"user", parts:[{ text:
`أصلحي JSON التالي ليكون صالحًا 100٪ ويطابق المخطط المطلوب.
أعيدي الكائن فقط بلا أي كودات أو شرح:

${raw}` }]}],
        generationConfig:{ temperature:0.2, response_mime_type:"application/json" }
      };
      const rr = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(fixPayload) });
      const jj = await rr.json().catch(()=>null);
      const raw2 = jj?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      data =
        tryParseJson(raw2) ||
        tryParseJson(extractJson(raw2)) ||
        tryParseJson(sanitizeJson(extractJson(raw2)));
    }

    if (!data) return json({ ok:false, error:"Bad JSON from model" }, 502);

    // تنعيم قيم العلميات العلمية: 5.0e+24 -> $5.0\\times10^{24}$
    tidyPayloadNumbers(data);

    return json({ ok:true, data });

  } catch (err) {
    return json({ ok:false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ================= Helpers ================= */
function json(obj, status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers:{ "Content-Type":"application/json; charset=utf-8" }
  });
}
async function safeJson(req){ try{ return await req.json(); }catch{ return {}; } }
function tryParseJson(s){ try{ return s && JSON.parse(s); }catch{ return null; } }

function extractJson(text){
  if (!text) return "";
  let t = (text+"")
    .replace(/\uFEFF/g,"")             // BOM
    .replace(/[\u200E\u200F\u202A-\u202E]/g,"") // علامات اتجاه
    .trim()
    .replace(/^```json/i,"```")
    .replace(/^```/,"")
    .replace(/```$/,"")
    .trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a>=0 && b>a) t = t.slice(a, b+1);
  return t;
}

// إصلاح محلي: استبدال الاقتباسات الذكية، حذف الفواصل الأخيرة، إلخ.
function sanitizeJson(t){
  return (t||"")
    .replace(/[“”]/g,'"')
    .replace(/[‘’]/g,"'")
    .replace(/,\s*([}\]])/g,"$1")           // trailing comma
    .replace(/:\s*undefined/g,": null")
    .replace(/\s+\n/g,"\n")
    .trim();
}

// تحويل 1.2e+5 -> LaTeX جميل
function sciToLatex(v){
  const s = (v??"")+"";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if(!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/,"$1$2");
  const exp  = parseInt(m[2],10);
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

/* ================= Prompt Builder ================= */
function buildPrompt(action, subject, concept, question){
  const BASE = `أنت خبيرة ${subject}.
اكتبي بالعربية الفصحى فقط (ممنوع الإنجليزية).
التزمي STRICTLY بالمفهوم المطلوب: «${concept}» ولا تنتقلي لغيره.
اكتبي الوحدات داخل \\mathrm{...} حصرًا: \\mathrm{N}, \\mathrm{kg}, \\mathrm{m/s^2} ...
استعملي ترميز LaTeX داخل $...$ أو $$...$$ للمعادلات والرموز ذات السفلية (m_1, v_f).
القيم العددية الكبيرة اكتبيها بصيغة LaTeX العلمية (a\\times10^{n}) لا بصيغة e.
أعيدي كائن JSON صالح فقط بدون أي شرح أو أسطر زائدة.`;

  const EXPLAIN_SCHEMA =
    `{"title":"string","overview":"string","symbols":[{"desc":"string","symbol":"string","unit":"string"}],"formulas":["string"],"steps":["string"]}`;
  const EXAMPLE_SCHEMA =
    `{"scenario":"string","givens":[{"symbol":"string","value":"string","unit":"string","desc":"string"}],"unknowns":[{"symbol":"string","desc":"string"}],"formula":"string","steps":["string"],"result":"string"}`;
  const PRACTICE_SCHEMA = `{"question":"string"}`;

  if (action === "explain"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${EXPLAIN_SCHEMA}
- اجعلي "formulas" صحيحة وتتعلق فقط بـ «${concept}».
- اجعلي "symbols" مختصرة: (desc عربي واضح، symbol مثل F أو m_1، unit داخل \\mathrm{...}).`;
  }

  if (action === "example"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${EXAMPLE_SCHEMA}
المستوى: متوسط. اختاري مجهولًا مناسبًا واحدًا لهذا المفهوم.
استخدمي قيَمًا منطقية ووحدات صحيحة. اشرحي الخطوات بالعربية، وأي معادلة داخل $...$.`;
  }

  if (action === "example2"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${EXAMPLE_SCHEMA}
المستوى: فوق المتوسط بدرجة (خطوات اعتماد/اشتقاق إضافية).
اختاري مجهولًا مختلفًا عن المثال الشائع لنفس المفهوم (متغير آخر من نفس القانون).
تأكدي أن القانون والصيغ تخص «${concept}» تحديدًا.`;
  }

  if (action === "practice"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${PRACTICE_SCHEMA}
اكتبي سؤال تدريب عربي فقط من 2–3 جُمل، بمستوى "متوسط".
غيّري السيناريو والمجهول في كل مرة (عشوائيًا بين متغيرات المفهوم الشائعة).
ضمّني أعدادًا مع وحداتها الصحيحة بصيغة LaTeX، وامتنعي عن e-notation نهائيًا.`;
  }

  if (action === "solve"){
    return `${BASE}
حلّي المسألة التالية وأعيدي JSON يطابق مخطط المثال: ${EXAMPLE_SCHEMA}
السؤال: ${question}
- رتّبي givens/unknowns بدقة ووحدات صحيحة.
- اجعلي Steps بالعربية وأي معادلة داخل $...$ أو $$...$$.
- ضعي النتيجة النهائية في "result" بصيغة LaTeX مع الوحدة.`;
  }

  return `${BASE}{"error":"unknown action"}`;
}
