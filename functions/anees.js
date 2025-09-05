// functions/anees.js
export default async (req, context) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return jsonError("Missing GEMINI_API_KEY", 500);
    }

    const { action, subject = "الفيزياء", concept = "", question = "" } = await req.json();
    if (!action) return jsonError("Missing action", 400);
    if (!concept) return jsonError("أدخل اسم القانون/المفهوم أولًا.", 400);

    const prompt = buildPrompt(action, subject, concept, question);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1000,
        response_mime_type: "application/json"
      }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const txt = await r.text();
      return jsonError(`Gemini HTTP ${r.status}: ${txt.slice(0,300)}`, 502);
    }

    const j = await r.json();
    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!raw) return jsonError("Empty response from model", 502);

    // حاول استخراج JSON من المخرَج
    let data = {};
    try {
      data = JSON.parse(extractJson(raw));
    } catch(e) {
      return jsonError("Bad JSON from model", 502);
    }

    // نرجع البيانات مباشرة (بدون تغليف ok/data)
    return new Response(JSON.stringify(data), { headers: { "Content-Type":"application/json" } });

  } catch (err) {
    return jsonError(err.message || "Unexpected error", 500);
  }
};

function jsonError(message, code=500){
  return new Response(JSON.stringify({ error: message }), {
    status: code,
    headers: { "Content-Type":"application/json" }
  });
}

function buildPrompt(action, subject, concept, question){
  const header =
`أنت خبير ${subject}.
اكتب عربيًا فصيحًا. الصيغ والرموز بالإنجليزية وLaTeX داخل $...$ أو $$...$$.
اكتب الوحدات داخل \\mathrm{} مثل: $9.8\\,\\mathrm{m/s^2}$.
المفهوم: «${concept}».`;

  if (action === "explain") {
    return header + `
أعيدي JSON بهذا الشكل بالضبط:
{
  "title": "عنوان قصير",
  "overview": "فقرة تمهيدية واضحة",
  "symbols": [
    "الوصف = القوة، الرمز = F، الوحدة = N",
    "الوصف = الكتلة، الرمز = m، الوحدة = kg",
    "الوصف = التسارع، الرمز = a، الوحدة = m/s^2"
  ],
  "formulas": ["$$F = m a$$"],
  "steps": ["١- استخراج المعطيات", "٢- تحديد المجاهيل", "٣- اختيار الصيغة المناسبة", "٤- التعويض ثم الحساب"]
}`;
  }

  if (action === "example") {
    return header + `
أعيدي JSON مثالًا تطبيقيًا مضبوطًا:
{
  "title": "عنوان المثال",
  "scenario": "وصف المسألة بعدد واحد على الأقل مع وحدة",
  "givens": [
    {"symbol":"m","value":"5.0","unit":"\\\\mathrm{kg}","desc":"كتلة الجسم"},
    {"symbol":"F","value":"20","unit":"\\\\mathrm{N}","desc":"القوة المؤثرة"}
  ],
  "unknowns": [{"symbol":"a","desc":"التسارع"}],
  "formulas": ["$$F = m a$$"],
  "steps": [
    "نكتب القانون $$F=ma$$",
    "نعوّض بالقيم: $$a = F/m$$",
    "نحسب القيمة بوحدتها مع توضيح التحويل إن وجد"
  ],
  "result": "$$a = 4\\,\\mathrm{m/s^2}$$"
}`;
  }

  if (action === "example2") {
    return header + `
مثال آخر على نفس المفهوم لكن غيّري المجهول (إن كان الأول a فاختاري m أو F مثلًا).
أعيدي نفس شكل JSON المستعمل في "example" تمامًا.`;
  }

  if (action === "practice") {
    return header + `
أعيدي JSON يحتوي سؤال تدريب واحد فقط دون حل:
{ "question": "صياغة مسألة رقمية صحيحة حول المفهوم مع أعداد ووحدات، بصيغة LaTeX عند الحاجة" }`;
  }

  if (action === "solve") {
    return header + `
احسبي حل المسألة التالية وأعيدي JSON مطابق لتنظيم "example":
السؤال: ${question}`;
  }

  return header;
}

function extractJson(text){
  if (!text) return "{}";
  let t = text.trim()
    .replace(/^```json/i,'```')
    .replace(/^```/,'')
    .replace(/```$/,'')
    .trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b+1);
  return t;
}
