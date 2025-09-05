// functions/anees.js
export default async (req, context) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // من بيئة نتلايفي
    if (!GEMINI_API_KEY) {
      return new Response(JSON.stringify({ ok:false, error:"Missing GEMINI_API_KEY" }), { status: 500 });
    }

    const { action, subject = "الفيزياء", concept = "", question = "" } = await req.json();

    const prompt = buildPrompt(action, subject, concept, question);

    // استدعاء Gemini 1.5 Flash (JSON output)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 900,
        response_mime_type: "application/json"
      }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();

    // نحاول نجيب النص الناتج (JSON كسلسلة)
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let data = {};
    try { data = JSON.parse(extractJson(text)); } catch(e){ 
      return new Response(JSON.stringify({ ok:false, error:"Bad JSON from model" }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok:true, data }), {
      headers: { "Content-Type":"application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ ok:false, error: err.message || "Unexpected error" }), { status: 500 });
  }
};

function buildPrompt(action, subject, concept, question){
  const header =
`أنت خبير ${subject}.
اكتب عربيًا فصيحًا. المعادلات والرموز بالإنجليزية وLaTeX بين $...$ أو $$...$$.
الوحدات داخل \\mathrm{} مثل: $9.8\\,\\mathrm{m/s^2}$.
المفهوم: «${concept}».`;

  if (action === "explain") {
    return header + `
أعيد JSON بهذا الشكل:
{
  "title": "عنوان قصير",
  "overview": "فقرة تمهيدية",
  "symbols": ["الوصف = قوة، الرمز = F، الوحدة = N", "..."],
  "formulas": ["F = m a", "..."], 
  "steps": ["١- استخراج المعطيات", "٢- تحديد المجاهيل", "٣- التعويض", "٤- الحساب"]
}`;
  }

  if (action === "example") {
    return header + `
أعيد JSON:
{
  "title": "عنوان المثال",
  "scenario": "وصف المسألة",
  "givens": [{"symbol":"m","value":"5","unit":"\\mathrm{kg}","desc":"الكتلة"}],
  "unknowns": [{"symbol":"a","desc":"التسارع"}],
  "formula": "$$F = m a$$",
  "steps": ["شرحي الخطوة ١", "٢", "٣"],
  "result": "$$a = 2\\,\\mathrm{m/s^2}$$"
}`;
  }

  if (action === "example2") {
    return header + `
مثال آخر على نفس المفهوم لكن بمجهول مختلف.
نفس شكل JSON السابق تمامًا.`;
  }

  if (action === "practice") {
    return header + `
أعيد JSON:
{ "question": "سؤال عددي كامل وصحيح حول المفهوم، دون حل" }`;
  }

  if (action === "solve") {
    return header + `
حل السؤال التالي بنفس تنسيق المثال (givens/unknowns/steps/result):
السؤال: ${question}`;
  }

  return header;
}

function extractJson(text){
  if (!text) return "{}";
  // إزالة ```json ... ``` إن وجدت
  let t = text.trim().replace(/^```json/,'```').replace(/^```/,'').replace(/```$/,'').trim();
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b+1);
  return t;
}
