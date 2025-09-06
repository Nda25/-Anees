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
    let data = tryParseJson(rawText);

    if (!data) {
      const extracted = extractJson(rawText);
      data = tryParseJson(extracted);
    }
    
    if (!data) {
      const fallbackPrompt = `أصلح JSON التالي. أعِد كائن JSON صحيحًا فقط:\n${rawText}`;
      const fallbackPayload = {
        contents: [{ role: "user", parts: [{ text: fallbackPrompt }] }],
        generationConfig: { temperature: 0.2, response_mime_type: "application/json" }
      };
      const fallbackRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fallbackPayload)
      });
      const fallbackJson = await fallbackRes.json().catch(() => null);
      const fallbackRawText = fallbackJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      data = tryParseJson(fallbackRawText);
    }
    
    if (!data) {
        return json({ ok: false, error: "Bad JSON from model" }, 502);
    }
    
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
async function safeJson(req) {
  try { return await req.json(); } catch (_) { return {}; }
}
function tryParseJson(s) { try { return s && JSON.parse(s); } catch (_) { return null; } }
function extractJson(text) {
  if (!text) return "";
  let t = (text + "").trim().replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/,"").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

function buildPrompt(action, subject, concept, question) {
  const header =
    `أنت خبير ${subject}.
اكتب عربيًا فصيحًا فقط. المعادلات بالـ LaTeX داخل $...$ أو $$...$$، والوحدات داخل \\mathrm{} (مثال: $9.8\\,\\mathrm{m/s^2}$).
أعِد دائمًا JSON صالحًا فقط، بدون أي شرح إضافي أو نص قبل وبعد الكائن.
المفهوم: «${concept}».`;

  const explainSchema = `
    "title":"عنوان",
    "overview":"تعريف موجز",
    "symbols":[
      {"desc":"القوة","symbol":"F","unit":"\\mathrm{N}"},
      {"desc":"الكتلة","symbol":"m","unit":"\\mathrm{kg}"},
      {"desc":"التسارع","symbol":"a","unit":"\\mathrm{m/s^2}"}
    ],
    "formulas":["$$F=ma$$", "$$a=\\frac{F}{m}$$"],
    "steps":["استخراج المعطيات والمجاهيل","تحديد الصيغة المناسبة","التعويض والحساب"]
  `.replace(/\s/g, '');

  const exampleSchema = `
    "scenario":"نص مسألة صحيحة وواضحة.",
    "givens":[{"symbol":"m","value":"5","unit":"\\mathrm{kg}","desc":"الكتلة"}],
    "unknowns":[{"symbol":"a","desc":"التسارع"}],
    "formula":"$$F = m a$$",
    "steps":["اكتب الخطوات بدون ترقيم. مثلا: رتب القانون ليصبح $a=F/m$"],
    "result":"$$a = 2\\,\\mathrm{m/s^2}$$"
  `.replace(/\s/g, '');

  if (action === "explain") {
    return `${header}\nأعِد JSON يطابق المخطط التالي تمامًا، واملأ الحقول ببيانات عن المفهوم.
    \nالمخطط: {${explainSchema}}`;
  }

  if (action === "example" || action === "example2") {
    const additionalHint = action === "example2" ? "المجهول يجب أن يكون مختلفًا عن المثال الأول." : "";
    return `${header}\nأعِد JSON يمثل مسألة تطبيقية عن المفهوم، واملأ الحقول ببيانات حقيقية. ${additionalHint}
    \nالمخطط: {${exampleSchema}}`;
  }

  if (action === "practice") {
    return `${header}\nأعِد JSON يحتوي على سؤال عددي كامل عن «${concept}» يتضمن قيمًا بوحدات صحيحة بصيغة LaTeX. بدون حل. \nالمثال: {"question":"نص السؤال"}`;
  }

  if (action === "solve") {
    return `${header}\nحل المسألة التالية بالتفصيل. املأ الحقول ببيانات الحل.
    \nالسؤال: ${question}\nالمخطط: {${exampleSchema}}`;
  }

  return `${header}{"note":"explain/example/example2/practice/solve فقط"}`;
}
