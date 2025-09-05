// functions/anees.js
export default async (req, context) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return json({ ok: false, error: "Missing GEMINI_API_KEY" }, 500);
    }

    const body = await safeJson(req);
    const { action, subject = "الفيزياء", concept = "", question = "" } = body || {};
    if (!concept) return json({ ok: false, error: "أدخلي اسم القانون/المفهوم." }, 400);

    const prompt = buildPrompt(action, subject, concept, question);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 900,
        response_mime_type: "application/json"
      }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const j = await r.json().catch(() => null);
    const rawText = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    let data = tryParseJson(rawText) || tryParseJson(extractJson(rawText));

    // محاولة إصلاح JSON إن لزم الأمر
    if (!data) {
      const fallbackPrompt =
        `أعد صياغة النص التالي إلى كائن JSON صالح فقط دون أي شرح:\n` + rawText;
      const fallbackPayload = {
        contents: [{ role: "user", parts: [{ text: fallbackPrompt }] }],
        generationConfig: { temperature: 0.2, response_mime_type: "application/json" }
      };
      const rr = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(fallbackPayload) });
      const jj = await rr.json().catch(()=>null);
      const txt = jj?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      data = tryParseJson(txt);
    }

    if (!data) return json({ ok:false, error:"Bad JSON from model" }, 502);

    return json({ ok: true, data });

  } catch (err) {
    return json({ ok: false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ===== Helpers ===== */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
async function safeJson(req) { try { return await req.json(); } catch { return {}; } }
function tryParseJson(s){ try{ return s && JSON.parse(s); }catch{ return null; } }
function extractJson(text){
  if (!text) return "";
  let t = (text+"").trim().replace(/^```json/i,"```").replace(/^```/,"").replace(/```$/,"").trim();
  const a=t.indexOf("{"), b=t.lastIndexOf("}");
  if (a>=0 && b>a) t=t.slice(a,b+1);
  return t;
}

/* ===== Prompt ===== */
function buildPrompt(action, subject, concept, question) {
  const header =
`أنت خبير ${subject}.
اكتب كل شيء بالعربية الفصحى فقط (ممنوع الإنجليزية) باستثناء رموز المتغيرات والوحدات وصيغ LaTeX.
استخدم LaTeX للمعادلات داخل $...$ أو $$...$$، والوحدات داخل \\mathrm{} (مثال: $9.8\\,\\mathrm{m/s^2}$).
أعد دائمًا JSON صالحًا فقط دون أي نص قبل/بعد الكائن.
المفهوم: «${concept}».`;

  const SYMBOL_LINE = `الوصف: وصف قصير للمقدار، الرمز: X، الوحدة: \\mathrm{unit}`;
  const explainSchema = `{
  "title": "عنوان قصير دقيق",
  "overview": "تعريف موجز ومتى يستخدم",
  "symbols": ["${SYMBOL_LINE}","${SYMBOL_LINE}"],
  "formulas": ["$$...$$","$$...$$"],
  "steps": ["اكتب خطوة واضحة بدون ترقيم يدوي","إن ظهرت معادلة داخل الخطوة فاكتبها بصيغة $$...$$"]
}`;

  const exampleSchema = `{
  "scenario": "نص مسألة تطبيقية عربية 100% بقيم واقعية",
  "givens": [{"symbol":"m","value":"5.0","unit":"\\\\mathrm{kg}","desc":"الكتلة"}],
  "unknowns": [{"symbol":"a","desc":"التسارع المطلوب"}],
  "formula": "$$F = m a$$",
  "steps": ["استخراج المعطيات (بدون ترقيم يدوي)","اختيار القانون وكتابة المعادلة بصيغة $$...$$","التعويض ثم الحساب"],
  "result": "$$a = 2.0\\\\,\\\\mathrm{m/s^2}$$"
}`;

  if (action === "explain") {
    return `${header}
أعد JSON يطابق المخطط التالي تمامًا. تأكّد أن عناصر "symbols" بالشكل: "الوصف: …، الرمز: X، الوحدة: \\mathrm{...}".
المخطط: ${explainSchema}`;
  }

  if (action === "example") {
    return `${header}
أعد JSON لمسألة تطبيقية وفق المخطط التالي. لا تستخدم الإنجليزية في الشرح، والمعادلات تكتب داخل $$...$$.
المخطط: ${exampleSchema}`;
  }

  if (action === "example2") {
    return `${header}
أعد JSON لمسألة أخرى بنفس المفهوم لكن بمجهول مختلف عن المثال الأول. نفس الشروط.
المخطط: ${exampleSchema}`;
  }

  if (action === "practice") {
    return `${header}
أعد JSON لسؤال تدريبي عربي 100% دون حل:
{ "question": "نص سؤال قصير يحتوي قيمًا ووحدات بصيغة LaTeX (مثال: $$v=20\\\\,\\\\mathrm{m/s}$$) وبلا أي معادلات محلولة" }`;
  }

  if (action === "solve") {
    return `${header}
حلّ السؤال التالي بالتفصيل وفق المخطط المستخدم في المثال (المعادلات داخل $$...$$ ولا يوجد ترقيم يدوي في نص الخطوات):
السؤال: ${question}
المخطط: ${exampleSchema}`;
  }

  return `${header}{"note":"explain | example | example2 | practice | solve فقط"}`;
}
