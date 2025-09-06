// functions/anees.js
export default async (req) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return send({ ok: false, error: "Missing GEMINI_API_KEY" }, 500);
    }

    const body = await safeJson(req);
    const { action = "explain", subject = "الفيزياء", concept = "", question = "" } = body || {};
    if (!concept) {
      return send({ ok: false, error: "أدخلي اسم القانون/المفهوم." }, 400);
    }

    // نبني البرومبت + الحمولة
    const prompt = buildPrompt(action, subject, concept, question);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const basePayload = {
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        candidateCount: 1,
        maxOutputTokens: 900,
        response_mime_type: "application/json",
        stopSequences: ["```", "\n\n\n"]
      }
    };

    // --- الطلب الأول
    let raw = await callGemini(url, basePayload);
    let data = parseAsJson(raw);

    // --- محاولة التصليح (طلب ثانٍ) إن فشل الأول
    if (!data) {
      const fixPayload = {
        contents: [{
          role: "user",
          parts: [{
            text:
`أعيدي صياغة المحتوى التالي إلى كائن JSON صالح 100٪ يطابق المخطط المطلوب.
أعيدي الكائن فقط، بدون أي نص خارج الأقواس، وبدون markdown.

${raw}`
          }]
        }],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: "application/json"
        }
      };
      raw = await callGemini(url, fixPayload);
      data = parseAsJson(raw);
    }

    // --- محاولة تصليح محلية إضافية
    if (!data) {
      const extracted = extractJson(raw);
      data = parseAsJson(extracted) || parseAsJson(sanitizeJson(extracted));
    }

    if (!data) {
      const snippet = (raw || "").slice(0, 400);
      return send({ ok: false, error: "Bad JSON from model", snippet }, 502);
    }

    // تنعيم الرموز والخطوات والقيم
    if (Array.isArray(data.steps)) {
      data.steps = data.steps.map(s => (s || "").toString().replace(/^\s*\d+[\).\-\:]\s*/, "").trim()).filter(Boolean);
    }
    wrapLatexSymbols(data, ["symbols", "givens", "unknowns"]);
    fixSciNumbers(data);

    return send({ ok: true, data });

  } catch (err) {
    return send({ ok: false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ----------------- Helpers ----------------- */
function send(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function safeJson(req) { try { return await req.json(); } catch { return {}; } }

async function callGemini(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  // لو فشل HTTP، نعيد نص واضح
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} — ${t.slice(0, 200)}`);
  }
  const j = await r.json().catch(() => null);
  return j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

function parseAsJson(s) {
  try {
    if (!s) return null;
    // إزالة أي كود Markdown محتمل
    let t = (s + "").trim();
    t = t.replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function extractJson(text) {
  if (!text) return "";
  let t = (text + "")
    .replace(/\uFEFF/g, "")
    .replace(/[\u200E\u200F\u202A-\u202E]/g, "")
    .trim()
    .replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

function sanitizeJson(t) {
  return (t || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/:\s*undefined/g, ": null")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function sciToLatex(v) {
  const s = (v ?? "") + "";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if (!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/, "$1$2");
  const exp = parseInt(m[2], 10);
  return `$${mant}\\times10^{${exp}}$`;
}

function fixSciNumbers(obj) {
  const fix = (x) => {
    if (typeof x === "number") return sciToLatex(x);
    const sx = (x ?? "") + "";
    if (/^\s*[+-]?\d+(\.\d+)?e[+-]?\d+\s*$/i.test(sx)) return sciToLatex(sx);
    return x;
  };
  if (Array.isArray(obj.givens)) obj.givens = obj.givens.map(g => ({ ...g, value: fix(g.value) }));
  if (Array.isArray(obj.unknowns)) obj.unknowns = obj.unknowns.map(u => ({ ...u, value: fix(u.value) }));
}

function wrapLatexSymbols(obj, fields) {
  fields.forEach(f => {
    const arr = obj[f];
    if (!Array.isArray(arr)) return;
    obj[f] = arr.map(item => {
      const sym = (item?.symbol ?? "") + "";
      const has = /^\$.*\$$/.test(sym);
      return { ...item, symbol: has ? sym : (sym ? `$${sym}$` : sym) };
    });
  });
}

/* --------------- Prompt Builder --------------- */
function buildPrompt(action, subject, concept, question) {
  const BASE =
`أنت خبيرة ${subject}.
اكتبي بالعربية الفصحى فقط (ممنوع الإنجليزية).
التزمي STRICTLY بالمفهوم المطلوب: «${concept}».
اكتبي الوحدات داخل \\mathrm{...} فقط: \\mathrm{N}, \\mathrm{kg}, \\mathrm{m/s^2}.
استخدمي LaTeX للمعادلات والرموز: داخل $...$ أو $$...$$.
القيم العلمية الكبيرة بصيغة a\\times10^{n} وليس e-notation.
أعيدي كائن JSON صالحًا فقط بدون أي شرح أو Markdown.

المخططات المقبولة:
- explain: {"title":"string","overview":"string","symbols":[{"desc":"string","symbol":"string","unit":"string"}],"formulas":["string"],"steps":["string"]}
- example/example2/solve: {"scenario":"string","givens":[{"symbol":"string","value":"string","unit":"string","desc":"string"}],"unknowns":[{"symbol":"string","desc":"string"}],"formula":"string","steps":["string"],"result":"string"}
- practice: {"question":"string"}`;

  if (action === "explain") {
    return `${BASE}
أعيدي JSON لحالة explain فقط.
- اجعلي "formulas" تخص «${concept}».
- "symbols": اختصري الوصف، الرمز مثل m أو v_f، الوحدة داخل \\mathrm{}.
- "steps": نقاط قصيرة مستقلّة.`;
  }

  if (action === "example") {
    return `${BASE}
أعيدي JSON لحالة example.
مستوى الصعوبة: متوسط. اختاري مجهولًا مناسبًا من متغيّرات «${concept}».
استعملي قيماً منطقية + وحدات صحيحة. كل خطوة عنصر مستقل في "steps".`;
  }

  if (action === "example2") {
    return `${BASE}
أعيدي JSON لحالة example2.
مستوى الصعوبة: فوق المتوسط بدرجة، واختاري مجهولًا مختلفًا عن المثال الشائع لنفس المفهوم.
التزمي بقوانين «${concept}» فقط. كل خطوة عنصر مستقل في "steps".`;
  }

  if (action === "practice") {
    return `${BASE}
أعيدي JSON لحالة practice فقط.
اكتبي سؤال تدريب عربي من 2–3 جمل، مستوى متوسط، وغيّري السيناريو/المجهول في كل مرة.
ضمّني أعدادًا مع وحداتها بصيغة LaTeX.`;
  }

  if (action === "solve") {
    return `${BASE}
أعيدي JSON لحالة solve (مثل example).
السؤال: ${question}
- نظّمي givens/unknowns بوحدات صحيحة.
- أي معادلة داخل $...$ أو $$...$$.
- أظهري النتيجة النهائية في "result" بـ LaTeX مع الوحدة.`;
  }

  return `${BASE}\n{"error":"unknown action"}`;
}
