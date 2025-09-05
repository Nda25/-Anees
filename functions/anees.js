// functions/anees.js
export default async (req) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return json({ ok: false, error: "Missing GEMINI_API_KEY" }, 500);
    }

    const { action, subject = "الفيزياء", concept = "", question = "" } = await req.json();
    if (!action) return json({ ok:false, error:"Missing action" }, 400);
    if (!concept && action !== "solve" && action !== "practice")
      return json({ ok:false, error:"أدخلي اسم القانون/المفهوم أولاً" }, 400);

    const prompt = buildPrompt(action, subject, concept, question);

    // Gemini 1.5 Flash
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1200,
        response_mime_type: "application/json"
      },
      // منع الحجب غير الضروري
      safetySettings: [
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH",        threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold: "BLOCK_NONE" }
      ]
    };

    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const j = await r.json();

    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) return json({ ok:false, error:"Empty response from model", raw:j }, 502);

    let data;
    try {
      data = JSON.parse(extractJson(text));
    } catch (e) {
      // نرجّع النص الخام للمساعدة في التشخيص
      return json({ ok:false, error:"Bad JSON from model", raw:text }, 502);
    }

    // نعيد الكائن مباشرة كما هو (بدون التفاف إضافي)
    return json({ ok:true, ...data });

  } catch (err) {
    return json({ ok:false, error: err.message || "Unexpected error" }, 500);
  }
};

// ===== Helpers =====
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function buildPrompt(action, subject, concept, question){
  const header =
`أنت خبير ${subject}.
اكتب بالعربية الفصحى. المعادلات والرموز بالإنجليزية و LaTeX بين $...$ أو $$...$$.
الوحدات تكتب داخل \\mathrm{} في الشرح العام، لكن رجاءً في جدول "الرموز والوحدات" اكتب الوحدات كنص واضح بلا LaTeX (مثال: N, kg, m/s^2).
أعيد ONLY كائن JSON صالح تمامًا بلا تعليق أو Markdown.

المفهوم: «${concept}».`;

  if (action === "explain") {
    // شرح القانون
    return header + `
{
  "title": "عنوان قصير للقانون أو الفكرة",
  "overview": "فقرة تمهيدية مبسطة.",
  "symbols": [
    "الوصف = القوة، الرمز = F، الوحدة = N",
    "الوصف = الكتلة، الرمز = m، الوحدة = kg",
    "الوصف = التسارع، الرمز = a، الوحدة = m/s^2"
  ],
  "formulas": [
    "$$F = m a$$"
  ],
  "steps": [
    "١- استخراج المعطيات",
    "٢- تحديد المجهول/المجاهيل",
    "٣- اختيار الصيغة المناسبة",
    "٤- التعويض والحساب مع كتابة الوحدة"
  ]
}`;
  }

  if (action === "example") {
    // مثال تطبيقي (المجهول 1)
    return header + `
{
  "title": "مثال تطبيقي",
  "scenario": "دُفِع جسم كتلته 10 kg بقوة ثابتة مقدارها 25 N. أوجد التسارع.",
  "givens": [
    {"symbol":"m","value":"10","unit":"kg","desc":"الكتلة"},
    {"symbol":"F","value":"25","unit":"N","desc":"القوة المؤثرة"}
  ],
  "unknowns": [{"symbol":"a","desc":"التسارع المطلوب"}],
  "formula": "$$F = m a$$",
  "steps": [
    "نستخدم: a = F / m",
    "a = 25 / 10 = 2.5"
  ],
  "result": "$$a = 2.5\\,\\mathrm{m/s^2}$$"
}`;
  }

  if (action === "example2") {
    // مثال آخر (المجهول مختلف)
    return header + `
{
  "title": "مثال آخر",
  "scenario": "جسم يتحرك بتسارع 3 m/s^2 تحت تأثير قوة مقدارها 18 N. احسب الكتلة.",
  "givens": [
    {"symbol":"a","value":"3","unit":"m/s^2","desc":"التسارع"},
    {"symbol":"F","value":"18","unit":"N","desc":"القوة"}
  ],
  "unknowns": [{"symbol":"m","desc":"الكتلة المجهولة"}],
  "formula": "$$F = m a$$",
  "steps": [
    "m = F / a",
    "m = 18 / 3 = 6"
  ],
  "result": "$$m = 6\\,\\mathrm{kg}$$"
}`;
  }

  if (action === "practice") {
    // اختبر فهمي (سؤال بلا حل)
    return header + `
{
  "question": "سُحِب صندوق بقوة أفقية 40 N فصار تسارعه 2 m/s^2. ما كتلته؟"
}`;
  }

  if (action === "solve") {
    // الحل الصحيح لنص السؤال المعروض
    return header + `
أعِد JSON بالتنظيم التالي: givens[], unknowns[], formula (أو formulas[]), steps[], result.
السؤال: ${question}`;
  }

  return header;
}

// يستخرج كتلة JSON من أي استجابة—even مع ```json
function extractJson(text){
  let t = (text || "").trim();
  t = t.replace(/^```json/,'```').replace(/^```/,'').replace(/```$/,'').trim();
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b+1);
  return t;
}
