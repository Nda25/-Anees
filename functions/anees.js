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

    // نبني البرومبت بحسب الإجراء
    const { prompt, temperature } = buildPrompt(action, subject, concept, question);

    // استدعاء Gemini 1.5 Flash وإلزامه بإرجاع JSON فقط
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,                // افتراضي منخفض، أعلى فقط للسؤال والأصعب قليلاً
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

    // محاولة قراءة JSON مباشرة
    const rawText = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let data = tryParseJson(rawText);

    // محاولة ثانية: قصّ أي حواشي ```json .. ```
    if (!data) {
      const extracted = extractJson(rawText);
      data = tryParseJson(extracted);
    }

    // محاولة ثالثة: نطلب منه إصلاح JSON
    if (!data) {
      const repairPrompt =
        `أصلحي JSON التالي ليكون صالحًا 100% لنفس المخطط المطلوب. أعِدي الكائن فقط:\n<<<\n${rawText}\n>>>`;
      const repairPayload = {
        contents: [{ role: "user", parts: [{ text: repairPrompt }] }],
        generationConfig: { temperature, response_mime_type: "application/json" }
      };
      const r2 = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(repairPayload)
      });
      const j2 = await r2.json().catch(() => null);
      const raw2 = j2?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      data = tryParseJson(raw2) || tryParseJson(extractJson(raw2));
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
  let t = (text + "")
    .trim()
    .replace(/^```json/i, "```")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

/* ===== Prompt builder (مع نفس المخططات – فقط تحسين المحتوى) ===== */
function buildPrompt(action, subject, concept, question) {
  const header =
`أنت خبير ${subject}.
اكتب عربيًا فصيحًا فقط (بدون إنجليزية إلا الرموز والوحدات القياسية).
المعادلات بصيغة LaTeX بين $...$ أو $$...$$، والوحدات داخل \\mathrm{} مثل: $9.8\\,\\mathrm{m/s^2}$.
أعِد دائمًا JSON صالحًا فقط، بدون أي شرح خارج الكائن.
المفهوم: «${concept}».`;

  // نفس مخطط "اشرح لي" لكن الرموز ككائنات واضحة (هذا ما يعتمد عليه الواجهة)
  const explainSchema = compactJson({
    title: "عنوان",
    overview: "تعريف موجز",
    symbols: [
      { desc: "القوة", symbol: "F", unit: "\\mathrm{N}" }
    ],
    formulas: ["$$F=ma$$"],
    steps: ["استخراج المعطيات والمجاهيل","تحديد الصيغة المناسبة","التعويض والحساب"]
  });

  // مخطط المثال/الحل
  const exampleSchema = compactJson({
    scenario: "نص المسألة",
    givens: [{ symbol: "m", value: "5", unit: "\\mathrm{kg}", desc: "الكتلة" }],
    unknowns: [{ symbol: "a", desc: "التسارع" }],
    formula: "$$F = m a$$",
    steps: ["خطوة تفسيرية بدون ترقيم يدوي داخل النص"],
    result: "$$a = 2\\,\\mathrm{m/s^2}$$"
  });

  // نُثبّت حرارة منخفضة افتراضيًا (للدقة)، ونرفعها قليلاً عند توليد الأسئلة لتقليل التكرار
  let temperature = 0.2;
  let prompt = header;

  if (action === "explain") {
    prompt +=
`\nأعِد JSON يطابق تمامًا المخطط التالي واملأ الحقول بدقة حول المفهوم:
${asObject(explainSchema)}`;
    return { prompt, temperature };
  }

  if (action === "example") {
    prompt +=
`\nأعِد JSON لمسألة تطبيقية **بمستوى صعوبة متوسط** حول المفهوم.
- عربية تمامًا.
- أرقام حقيقية معقولة (تجنّب 5 و10 و100) وسمات غير مكررة.
- اختر مجهولًا مناسبًا للمفهوم.
- صياغة المسألة من جملتين إلى ثلاث، واضحة وغير مكررة.
- استخدم وحدات SI داخل \\mathrm{}.
- لا تكتب ترقيمًا داخل عناصر steps (الواجهة ترقم تلقائيًا).
المخطط (التزمي به حرفيًا):
${asObject(exampleSchema)}`;
    return { prompt, temperature: 0.35 }; // زيادة طفيفة للتنويع
  }

  if (action === "example2") {
    prompt +=
`\nأعِد JSON لمسألة تطبيقية **أصعب بقليل من المثال الأول** حول نفس المفهوم.
- غيّري **المجهول** بحيث يختلف عن المثال الأول قدر الإمكان.
- أضيفي تعقيدًا بسيطًا مثل: تحويل وحدات، رقمين عشريين، أو قيمة عند زاوية (إن كان مناسبًا للمفهوم).
- صياغة عربية من جملتين إلى ثلاث.
- قيم غير “مريحة” (مثل 7.4, 3.6, 12.8 بدل 5 أو 10).
- لا تكتبي ترقيمًا داخل steps.
المخطط (التزمي به حرفيًا):
${asObject(exampleSchema)}`;
    return { prompt, temperature: 0.4 }; // أصعب → تنويع أكبر قليلًا
  }

  if (action === "practice") {
    prompt +=
`\nأعِد JSON يحتوي **سؤال تدريب واحد** فقط في الحقل question، **بالعربية فقط**، و**بمستوى صعوبة متوسط**:
- صياغة من جملتين إلى ثلاث جمل واضحة.
- استخدمي قيمًا بأعداد تختلف في كل مرة (عشوائية مع منزلتين عشريتين ضمن نطاقات معقولة).
- **اختاري مجهولًا مختلفًا** قدر الإمكان عن الأمثلة المباشرة للمفهوم (إن أمكن).
- جميع القيم بوحدات SI داخل \\mathrm{} (مثل \\mathrm{N}, \\mathrm{kg}, \\mathrm{m/s}, \\mathrm{m/s^2}).
- **بدون حل**، فقط السؤال.
- أعِدي JSON بهذا الشكل فقط:
{"question":"نص السؤال بالعربية فقط."}`;
    return { prompt, temperature: 0.55 }; // نرفع أكثر عشان التنويع وتفادي التكرار
  }

  if (action === "solve") {
    prompt +=
`\nحلّ المسألة التالية بالتفصيل وفق المخطط (نفس exampleSchema)، ولا تضع ترقيمًا يدويًا داخل steps:
السؤال: ${question}
المخطط (التزمي به حرفيًا):
${asObject(exampleSchema)}`;
    return { prompt, temperature };
  }

  // افتراضي
  prompt += `\n{"note":"explain/example/example2/practice/solve فقط"}`;
  return { prompt, temperature };
}

/* Utilities لعرض المخططات بشكل مدمج داخل البرومبت */
function compactJson(obj){ return JSON.stringify(obj).replace(/\s+/g,''); }
function asObject(str){ return (str.startsWith('{') ? str : `{${str}}`); }
