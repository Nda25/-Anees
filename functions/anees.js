// functions/anees.js
export default async (req, context) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return json({ ok:false, error: "Missing GEMINI_API_KEY" }, 500);
    }

    const body = await safeJson(req);
    const { action, subject = "الفيزياء", concept = "", question = "" } = body || {};
    if (!concept) return json({ ok:false, error:"أدخلي اسم القانون/المفهوم." }, 400);

    const prompt = buildPrompt(action, subject, concept, question);

    // Gemini 1.5 Flash with JSON mime type
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 900,
        response_mime_type: "application/json"
      }
    };

    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    const j = await r.json().catch(()=>null);

    // التقط النص الناتج
    const rawText = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let data = tryParseJson(rawText);

    if (!data) {
      // بعض الأحيان يرجع النموذج نصًا يحيط بالـ JSON — نحاول اقتطافه
      const extracted = extractJson(rawText);
      data = tryParseJson(extracted);
    }

    if (!data) {
      return json({ ok:false, error:"Bad JSON from model", raw: rawText }, 502);
    }

    // نعيد الكائن مباشرة أو داخل data — كلاهما تدعمه الواجهة
    return json({ ok:true, data });

  } catch (err) {
    return json({ ok:false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ===== Helpers ===== */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type":"application/json; charset=utf-8" } });
}
async function safeJson(req){
  try { return await req.json(); } catch(_) { return {}; }
}
function tryParseJson(s){ try{ return s && JSON.parse(s); }catch(_){ return null; } }
function extractJson(text){
  if (!text) return "";
  let t = (text+"").trim().replace(/^```json/i,"```").replace(/^```/,"").replace(/```$/,"").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a>=0 && b>a) t = t.slice(a, b+1);
  return t;
}

function buildPrompt(action, subject, concept, question){
  const header =
`أنت خبير ${subject}.
اكتب عربيًا فصيحًا. المعادلات بالـ LaTeX داخل $...$ أو $$...$$، والوحدات داخل \\mathrm{} (مثال: $9.8\\,\\mathrm{m/s^2}$).
أعيدي دائمًا JSON صالحًا بدون شرح إضافي.
المفهوم: «${concept}».`;

  if (action === "explain") {
    return header + `
{
  "title": "عنوان قصير",
  "overview": "تعريف ووصف موجز للمفهوم",
  "symbols": ["الوصف = القوة، الرمز = F، الوحدة = \\mathrm{N}", "الوصف = الكتلة، الرمز = m، الوحدة = \\mathrm{kg}"],
  "formulas": ["$$F = m a$$"],
  "steps": ["١- استخراج المعطيات", "٢- تحديد المجاهيل", "٣- اختيار الصيغة المناسبة", "٤- التعويض والحساب"]
}`;
  }

  if (action === "example") {
    return header + `
{
  "title": "مثال تطبيقي",
  "scenario": "نص مسألة صحيحة وواضحة.",
  "givens": [{"symbol":"m","value":"5","unit":"\\mathrm{kg}","desc":"الكتلة"},{"symbol":"F","value":"10","unit":"\\mathrm{N}","desc":"القوة"}],
  "unknowns": [{"symbol":"a","desc":"التسارع"}],
  "formula": "$$F = m a$$",
  "steps": ["ترتيب الصيغة: $$a = \\frac{F}{m}$$","التعويض بالقيم","الحساب وكتابة الوحدة"],
  "result": "$$a = 2\\,\\mathrm{m/s^2}$$"
}`;
  }

  if (action === "example2") {
    return header + `
"أعيدي مثالًا آخر على نفس المفهوم لكن بجعل المجهول مختلفًا.
استخدمي نفس شكل JSON السابق تمامًا."`;
  }

  if (action === "practice") {
    return header + `
{ "question": "سؤال عددي كامل عن «${concept}» يتضمن قيمًا بوحدات صحيحة بصيغة LaTeX، بدون حل." }`;
  }

  if (action === "solve") {
    return header + `
حل السؤال التالي بنفس حقول JSON: givens[], unknowns[], formula أو formulas[], steps[], result (صيغة LaTeX).
السؤال: ${question}`;
  }

  // افتراضي
  return header + `{"note":"explain/example/example2/practice/solve فقط"}`;
}
