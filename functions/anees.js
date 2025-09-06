// functions/anees.js  — تحسين تنويع وصعوبة الأسئلة + ثبات العربية + صلابة JSON
export default async (req, context) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return json({ ok: false, error: "Missing GEMINI_API_KEY" }, 500);
    }

    const body = await safeJson(req);
    const { action, subject = "الفيزياء", concept = "", question = "" } = body || {};
    if (!concept) return json({ ok: false, error: "أدخلي اسم القانون/المفهوم." }, 400);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    // 1) الطلب الأساسي
    const prompt = buildPrompt(action, subject, concept, question);
    let data = await callOnce(url, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: action === "practice" ? 0.65 : action === "example2" ? 0.45 : 0.3,
        maxOutputTokens: 900,
        response_mime_type: "application/json"
      }
    });

    // 2) إصلاح عام لو فشل
    if (!data) {
      const fixPrompt =
        `أصلحي/أصلح JSON التالي ليطابق القالب المطلوب. أعِد كائن JSON صالحًا فقط بلا أي نص خارجي:\n<<<\n${prompt}\n>>>`;
      data = await callOnce(url, {
        contents: [{ role: "user", parts: [{ text: fixPrompt }] }],
        generationConfig: { temperature: 0.25, response_mime_type: "application/json" }
      });
    }

    // 2-ب) تشديد خاص لـ practice لو قصير/إنجليزي/بدون وحدات
    if (action === "practice") {
      const needsRedo =
        !data ||
        typeof data.question !== "string" ||
        data.question.length < 80 ||                  // نمنع الأسئلة القصيرة جدًا
        /[A-Za-z]/.test(data.question) ||            // نمنع الإنجليزية
        !/\\mathrm\{[^}]+\}/.test(data.question);    // نتأكد من وجود وحدة واحدة على الأقل

      if (needsRedo) {
        const strictPractice =
`أعِد JSON بالعربية فقط وبدون أي نص خارجي، بالشكل التالي تمامًا:
{"question":"سؤال عربي عددي كامل وصحيح عن «${concept}» يحتوي على 2–4 معطيات على الأقل، ومجهول واحد فقط مختلف عشوائيًا في كل مرة، وطول السؤال لا يقل عن 20 كلمة، وكل قيمة عددية لها وحدة LaTeX داخل \\mathrm{}، وبدون حل."}

إرشادات المحتوى:
- المستوى المطلوب: متوسط (خطوة أو خطوتان).
- أمثلة للوحدات فقط (لا تنسخ الأرقام): \\mathrm{N}, \\mathrm{kg}, \\mathrm{m/s^2}, \\mathrm{m}, \\mathrm{s}.
- ابتعد عن الأعداد التافهة كـ 1 و2 فقط؛ استعمل قيمًا معقولة (مثل 3.2، 45، 9.8...).`;
        data = await callOnce(url, {
          contents: [{ role: "user", parts: [{ text: strictPractice }] }],
          generationConfig: { temperature: 0.6, response_mime_type: "application/json" }
        });
      }

      // 3) fallback محلي مضمون
      if (!data || !data.question) {
        data = {
          question:
            `كتلة صندوق مقدارها $6.5\\,\\mathrm{kg}$ سُحبت أفقياً بقوة ثابتة $18\\,\\mathrm{N}$ على سطح أملس لمسافة $4.0\\,\\mathrm{m}$. احسب التسارع الذي اكتسبه الصندوق، ثم فسّر هل تصل سرعته النهائية خلال $3.0\\,\\mathrm{s}$ إلى قيمة أكبر من $6\\,\\mathrm{m/s}$ أم لا، مع إهمال مقاومة الهواء.`
        };
      }
    }

    if (!data) return json({ ok: false, error: "Bad JSON from model" }, 502);
    return json({ ok: true, data });

  } catch (err) {
    return json({ ok: false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ---------- helpers ---------- */
async function callOnce(url, payload){
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => null);

  const cand = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  let obj = tryParseJson(cand);
  if (!obj) obj = tryParseJson(extractJson(cand));
  return obj;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
async function safeJson(req) { try { return await req.json(); } catch(_) { return {}; } }
function tryParseJson(s){ try { return s && JSON.parse(s); } catch(_){ return null; } }
function extractJson(text){
  if (!text) return "";
  let t = (text+"").trim().replace(/^```json/i,"```").replace(/^```/,"").replace(/```$/,"").trim();
  const a=t.indexOf("{"), b=t.lastIndexOf("}");
  if(a>=0 && b>a) t=t.slice(a,b+1);
  return t;
}

/* ---------- prompt builder ---------- */
function buildPrompt(action, subject, concept, question){
  const salt = Math.floor(Math.random()*1e9); // لتحسين التنويع
  const header =
`أنت خبير ${subject}.
اكتب بالعربية الفصحى فقط. المعادلات بـ LaTeX داخل $...$ أو $$...$$، والوحدات داخل \\mathrm{} (مثل: $9.8\\,\\mathrm{m/s^2}$).
أعِد دائمًا JSON صالحًا فقط، بدون أي نص خارجي قبل أو بعد الكائن.
المفهوم: «${concept}».`;

  const explainSchema = `{
    "title":"عنوان",
    "overview":"تعريف موجز",
    "symbols":[
      {"desc":"القوة","symbol":"F","unit":"\\\\mathrm{N}"},
      {"desc":"الكتلة","symbol":"m","unit":"\\\\mathrm{kg}"},
      {"desc":"التسارع","symbol":"a","unit":"\\\\mathrm{m/s^2}"}
    ],
    "formulas":["$$F=ma$$","$$a=\\\\frac{F}{m}$$"],
    "steps":["استخراج المعطيات والمجاهيل","تحديد الصيغة المناسبة","التعويض والحساب"]
  }`;

  const exampleSchema = `{
    "scenario":"نص مسألة عربية صحيحة وواضحة.",
    "givens":[
      {"symbol":"m","value":"5.0","unit":"\\\\mathrm{kg}","desc":"الكتلة"},
      {"symbol":"F","value":"12","unit":"\\\\mathrm{N}","desc":"القوة"}
    ],
    "unknowns":[{"symbol":"a","desc":"التسارع"}],
    "formula":"$$a=\\\\frac{F}{m}$$",
    "steps":[
      "رتّب القانون المناسب بحيث يصبح المجهول في طرف واحد.",
      "عوّض بالقيم مع الوحدات ثم اجمع/اطرح/اضرب/اقسم حسب الحاجة.",
      "أجِرِ الحساب وقدّم الناتج النهائي بوحدة صحيحة."
    ],
    "result":"$$a=2.4\\\\,\\\\mathrm{m/s^2}$$"
  }`;

  if (action === "explain") {
    return `${header}
أعِد JSON يطابق القالب التالي حرفيًا بلا نص خارجي:
${explainSchema}`;
  }

  if (action === "example") {
    return `${header}
أعِد JSON لمثال تطبيقي عن المفهوم بالقالب التالي حرفيًا (مستوى صعوبة متوسط):
${exampleSchema}
ملحظات: لا تضف أي حقول غير موجودة في القالب.`;
  }

  if (action === "example2") {
    // أصعب بدرجة: نطلب خطوتين/تحويل بسيط/مجهول مختلف
    return `${header}
أعِد مثالًا آخر بمجهول مختلف عن المثال الأول (إن كان الأول يحسب a فاحسب m أو F مثلًا).
المستوى: فوق المتوسط بدرجة بسيطة (يتطلّب خطوتين أو تحويل وحدة بسيط).
ملحظات التوليد:
- اجعل المعطيات 2–3 على الأقل وبقية الصياغة عربية سليمة.
- أدرِج تحويلًا بسيطًا واحدًا إن لزم (مثل cm إلى m) أو إعادة ترتيب قانون واضحة.
ملح عشوائي:${salt}
أعِد JSON يطابق القالب التالي حرفيًا بلا نص خارجي:
${exampleSchema}`; // نستخدم نفس القالب لكن على الموديل اختيار مجهول مختلف وصعوبة أعلى
  }

  if (action === "practice") {
    return `${header}
أعِد JSON بالعربية فقط يحتوي سؤالًا عدديًا كاملًا عن «${concept}» (بدون حل) مع 2–4 معطيات على الأقل ومجهول واحد، وطول لا يقل عن 20 كلمة، وكل قيمة لها وحدة \\mathrm{}، وبمستوى صعوبة متوسط. لا تضف أي نص خارج JSON:
{"question":"..."}
ملح عشوائي:${salt}`;
  }

  if (action === "solve") {
    return `${header}
حلّل المسألة التالية بالتفصيل بنفس قالب المثال (givens/unknowns/formula/steps/result) وأعِد JSON فقط:
السؤال: ${question}
القالب:
${exampleSchema}`;
  }

  return `${header}{"note":"explain/example/example2/practice/solve فقط"}`;
}
