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

    // NONCE لتغيير صياغة السؤال/الأمثلة في كل نداء
    const nonce = makeNonce();

    // نضبط الإعدادات حسب الإجراء لزيادة التنويع/الصعوبة
    const cfg = pickGenConfig(action);

    const prompt = buildPrompt(action, subject, concept, question, { nonce });

    // الاستدعاء الأساسي
    let data = await callModelJSON({
      key: GEMINI_API_KEY,
      prompt,
      temperature: cfg.temperature,
      maxOutputTokens: cfg.maxTokens
    });

    // خاص بـ "اختبر فهمي": لو خرج سؤال قصير/فيه إنجليزي نعيد المحاولة تلقائيًا
    if (action === "practice") {
      const q = (data && data.question) ? `${data.question}` : "";
      if (!isGoodArabicQuestion(q)) {
        const prompt2 = buildPrompt("practice", subject, concept, question, { nonce: makeNonce(), retry: true });
        data = await callModelJSON({
          key: GEMINI_API_KEY,
          prompt: prompt2,
          temperature: Math.max(0.7, cfg.temperature),
          maxOutputTokens: cfg.maxTokens
        });
      }
    }

    if (!data) {
      return json({ ok: false, error: "Bad JSON from model" }, 502);
    }

    return json({ ok: true, data });

  } catch (err) {
    return json({ ok: false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ================= Helpers ================= */

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

function makeNonce() {
  // NONCE قصير ويختلف كل مرّة
  return Math.floor((Date.now() % 1e9) + Math.random() * 1e6).toString(36);
}

function pickGenConfig(action) {
  // نلعب بالـ temperature حسب المطلوب
  // explain/example/solve هادئة، example2 أصعب قليلاً، practice أكثر تنوّعًا
  switch (action) {
    case "practice":
      return { temperature: 0.65, maxTokens: 900 };
    case "example2":
      return { temperature: 0.45, maxTokens: 900 };
    case "example":
    case "solve":
    case "explain":
    default:
      return { temperature: 0.3, maxTokens: 900 };
  }
}

async function callModelJSON({ key, prompt, temperature = 0.2, maxOutputTokens = 900 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: {
      temperature,
      maxOutputTokens,
      response_mime_type: "application/json"
    }
  };

  // المحاولة الأولى
  let j = await doFetchJSON(url, payload);
  let rawText = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  let data = tryParseJson(rawText);

  // إصلاح بالأخذ من كتلة JSON داخل النص إن وُجد
  if (!data) {
    const extracted = extractJson(rawText);
    data = tryParseJson(extracted);
  }

  // إصلاح تلقائي: نطلب منه إعادة هيكلة JSON فقط
  if (!data) {
    const fixPrompt = `أصلح كائن JSON التالي ليكون صالحًا تمامًا. أعد كائن JSON فقط دون أي شروحات:\n${rawText}`;
    const fixPayload = {
      contents: [{ role: "user", parts: [{ text: fixPrompt }]}],
      generationConfig: { temperature: 0.2, response_mime_type: "application/json" }
    };
    const j2 = await doFetchJSON(url, fixPayload);
    const raw2 = j2?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    data = tryParseJson(raw2) || tryParseJson(extractJson(raw2));
  }

  return data;
}

async function doFetchJSON(url, bodyObj) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(bodyObj)
  });
  const j = await r.json().catch(() => null);
  return j;
}

/* ---------- Arabic question quality guard ---------- */
function isGoodArabicQuestion(q) {
  if (!q) return false;
  // لا إنجليزي
  if (/[A-Za-z]/.test(q)) return false;
  // طول مقبول
  const len = q.trim().length;
  if (len < 60) return false; // نخلي الحد الأدنى أعلى شوي عشان ما يكون قصير
  return true;
}

/* ================= Prompts ================= */

function buildPrompt(action, subject, concept, question, { nonce = "", retry = false } = {}) {
  const header =
`أنت خبير ${subject}.
اكتب بالعربية الفصحى فقط. لا تستخدم الإنجليزية نهائيًا في الشرح أو نص المسألة، باستثناء رموز المعادلات (مثل F, m, a) وصيغ LaTeX.
المعادلات تُكتب بـ LaTeX داخل $...$ أو $$...$$، والوحدات داخل \\mathrm{} مثل: $9.8\\,\\mathrm{m/s^2}$.
أعِد دائمًا JSON صالحًا فقط، بدون أي نص أو شرح خارج الكائن.
المفهوم: «${concept}».
NONCE=${nonce}`;

  // مخطط الشرح (symbols = كائنات واضحة)
  const explainSchema = removeSpaces(`
  {
    "title":"عنوان",
    "overview":"تعريف موجز",
    "symbols":[
      {"desc":"القوة","symbol":"F","unit":"\\\\mathrm{N}"},
      {"desc":"الكتلة","symbol":"m","unit":"\\\\mathrm{kg}"},
      {"desc":"التسارع","symbol":"a","unit":"\\\\mathrm{m/s^2}"}
    ],
    "formulas":["$$F=ma$$", "$$a=\\\\frac{F}{m}$$"],
    "steps":["استخراج المعطيات والمجاهيل","تحديد الصيغة المناسبة","التعويض والحساب"]
  }`);

  // مخطط المثال/الحل (نفسه للمثال، مثال آخر، والحل الصحيح)
  const exampleSchema = removeSpaces(`
  {
    "scenario":"نص المسألة بالعربية",
    "givens":[{"symbol":"m","value":"5","unit":"\\\\mathrm{kg}","desc":"الكتلة"}],
    "unknowns":[{"symbol":"a","desc":"التسارع"}],
    "formula":"$$a=\\\\frac{F}{m}$$",
    "steps":["خطوة 1 بصياغة عربية واضحة","خطوة 2","خطوة 3"],
    "result":"$$a = 2\\\\,\\\\mathrm{m/s^2}$$"
  }`);

  if (action === "explain") {
    return `${header}
أعِد JSON يطابق المخطط التالي تمامًا، واملأ الحقول ببيانات صحيحة عن المفهوم.
- اكتب الخطوات بدون ترقيم داخل النص (الواجهة تقوم بالترقيم).
- تأكد أن symbols هي كائنات {desc,symbol,unit}:
المخطط: ${explainSchema}`;
  }

  if (action === "example") {
    return `${header}
أعِد JSON لمسألة تطبيقية بمستوى **متوسط** عن «${concept}». 
- لُغة عربية واضحة وكاملة.
- صيغة واحدة رئيسية في "formula" وباقي الصيغ (إن وجدت) ضمن "steps" بصيغة LaTeX.
- steps عناصر بدون أرقام (واجهة العرض تُرقّم تلقائيًا).
- احرص أن تكون القيم والأعداد **واقعية** وبوحدات صحيحة.
المخطط: ${exampleSchema}`;
  }

  if (action === "example2") {
    return `${header}
أعِد JSON لمسألة تطبيقية **أصعب بدرجة واحدة** من المثال العادي عن «${concept}»، 
ويجب أن يكون **المجهول مختلفًا** عن المثال الأول المعتاد لهذا المفهوم.
- عربي فصيح فقط.
- خطوات بدون أرقام ضمن النص.
- أعداد واقعية ووحدات صحيحة.
المخطط: ${exampleSchema}`;
  }

  if (action === "practice") {
    const tighten = retry ? `
- اجعل طول السؤال بين 60 و120 كلمة.
- ممنوع كليًا استخدام أي كلمة إنجليزية (عدا رموز المعادلات).
- اختر **مجهولًا مختلفًا** عن المجهول الشائع في هذا المفهوم.
- غيّر سياق المسألة وبياناتها جذريًا عندما يتغيّر NONCE.` : `
- عربي فقط.
- الطول بين 40 و100 كلمة.
- مستوى **متوسط**، مع قيم عددية واقعية ووحدات صحيحة.
- اختر مجهوﻻً مناسبًا وغير تافه، وغيّر السؤال عندما يتغيّر NONCE.`;

    return `${header}
أعِد JSON يحوي سؤالًا عدديًا كاملاً عن «${concept}» **بدون حل**:
{"question":"نص السؤال بالعربية فقط"} 
${tighten}`;
  }

  if (action === "solve") {
    return `${header}
حل المسألة التالية بالتفصيل، وأعِد JSON يطابق مخطط المثال (givens/unknowns/steps/result).
- اكتب الخطوات عربية وواضحة وبدون أرقام ضمن النص.
- تأكد أن النتيجة النهائية بصيغة LaTeX في "result".
السؤال: ${question}
المخطط: ${exampleSchema}`;
  }

  return `${header}{"note":"explain/example/example2/practice/solve فقط"}`;
}

function removeSpaces(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
