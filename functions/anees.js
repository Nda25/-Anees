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

    // المحاولة الأساسية
    let data = await callOnce(url, payload);

    // إصلاح إذا لسه فشل
    if (!data) {
      const fallbackPrompt = `أصلح JSON التالي ليطابق القالب المطلوب. أعِد كائن JSON صحيحًا فقط:\n<<<\n${prompt}\n>>>`;
      data = await callOnce(url, {
        contents: [{ role: "user", parts: [{ text: fallbackPrompt }] }],
        generationConfig: { temperature: 0.2, response_mime_type: "application/json" }
      });
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
  const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  let data = tryParseJson(raw);
  if (!data) data = tryParseJson(extractJson(raw));
  return data;
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
  const rand = Math.floor(Math.random()*1e9); // لتجديد النتائج في practice/example2
  const header =
`أنت خبير ${subject}.
اكتب عربيًا فصيحًا فقط. المعادلات بـ LaTeX داخل $...$ أو $$...$$، والوحدات داخل \\mathrm{} (مثال: $9.8\\,\\mathrm{m/s^2}$).
أعِد دائمًا JSON صالحًا فقط، بدون أي شرحٍ أو نص خارجي.
المفهوم: «${concept}».`;

  const explainSchema = `{
    "title":"عنوان",
    "overview":"تعريف موجز",
    "symbols":[
      {"desc":"القوة","symbol":"F","unit":"\\\\mathrm{N}"},
      {"desc":"الكتلة","symbol":"m","unit":"\\\\mathrm{kg}"},
      {"desc":"التسارع","symbol":"a","unit":"\\\\mathrm{m/s^2}"}
    ],
    "formulas": ["$$F=ma$$","$$a=\\\\frac{F}{m}$$"],
    "steps":["استخراج المعطيات والمجاهيل","تحديد الصيغة المناسبة","التعويض والحساب"]
  }`;

  const exampleSchema = `{
    "scenario":"نص مسألة صحيحة وواضحة.",
    "givens":[{"symbol":"m","value":"5.0","unit":"\\\\mathrm{kg}","desc":"الكتلة"},{"symbol":"F","value":"10","unit":"\\\\mathrm{N}","desc":"القوة"}],
    "unknowns":[{"symbol":"a","desc":"التسارع"}],
    "formula":"$$a=\\\\frac{F}{m}$$",
    "steps":["رتّب القانون المناسب","عوّض بالقيم مع الوحدات","أجِرِ الحساب مع توضيح الناتج"],
    "result":"$$a=2\\\\,\\\\mathrm{m/s^2}$$"
  }`;

  if (action === "explain") {
    return `${header}\nأعِد JSON يطابق القالب التالي حرفيًا:\n${explainSchema}`;
  }

  if (action === "example") {
    return `${header}\nأعِد JSON لمثال تطبيقي عن المفهوم بالقالب التالي حرفيًا:\n${exampleSchema}`;
  }

  if (action === "example2") {
    // مجبر على مجهول مختلف + رقم عشوائي لضمان التغيير
    return `${header}
المطلوب: مثال آخر عن نفس المفهوم بمجهول مختلف عن المثال الأول (إن كان الأول عن a فليكن عن m مثلًا أو F).
أعِد JSON يطابق القالب التالي حرفيًا. لا تضف أي نص خارج JSON.
رقم_عشوائي:${rand}
${exampleSchema}`;
  }

  if (action === "practice") {
    return `${header}
أعِد JSON يحتوي سؤالًا عدديًا عربيًا كاملًا عن «${concept}» (بدون حل) مع قيم ووحدات صحيحة بـ LaTeX:
{"question":"..."}
رقم_عشوائي:${rand}`;
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
