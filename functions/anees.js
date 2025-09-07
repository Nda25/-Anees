// functions/anees.js
export default async (req) => {
  try {
    // ---- إعدادات عامة
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return send({ ok: false, error: "Missing GEMINI_API_KEY" }, 500);
    }

    const body = await safeJson(req);
    const {
      action = "explain",
      subject = "الفيزياء",
      concept = "",
      question = ""
    } = body || {};

    if (!concept) {
      return send({ ok: false, error: "أدخلي اسم القانون/المفهوم." }, 400);
    }

    // ---- بناء البرومبت
    const prompt = buildPrompt(action, subject, concept, question);

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
      GEMINI_API_KEY;

    // ملاحظة: المفتاح الصحيح هو response_mime_type (بشرطة سفلية)
    const basePayload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.15,
        topP: 0.9,
        maxOutputTokens: 1200,
        response_mime_type: "application/json"
      }
    };

    // ---- الطلب الأول
    let raw = await callGemini(url, basePayload);
    let data = parseAsJson(raw);

    // ---- إن فشل، نطلب إصلاحًا بصيغة JSON فقط
    if (!data) {
      const repairPayload = {
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "أعيدي صياغة النص التالي إلى JSON صالح 100% يطابق المخطط المطلوب تمامًا. " +
                  "أعيدي الكائن فقط بدون أي نص خارج الأقواس، وبدون markdown.\n\n" +
                  raw
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.05,
          maxOutputTokens: 1200,
          response_mime_type: "application/json"
        }
      };
      raw = await callGemini(url, repairPayload);
      data = parseAsJson(raw);
    }

    // ---- محاولة استخراج/تنظيف محلية
    if (!data) {
      const extracted = extractJson(raw);
      data = parseAsJson(extracted) || parseAsJson(sanitizeJson(extracted));
    }

    if (!data) {
      const snippet = (raw || "").slice(0, 400);
      return send({ ok: false, error: "Bad JSON from model", snippet }, 502);
    }

    // ---- تنعيم الحقول (إزالة أرقام التعداد من steps، وتغليف الرموز، وتحويل e-notation)
    if (Array.isArray(data.steps)) {
      data.steps = data.steps
        .map((s) => (s || "").toString().replace(/^\s*\d+[\).\-\:]\s*/, "").trim())
        .filter(Boolean);
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
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // CORS إن لزم
      "Access-Control-Allow-Origin": "*"
    }
  });
}

async function safeJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function callGemini(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  // إن فشل HTTP نعيد رسالة واضحة
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
    // إزالة سياج markdown إن وُجد
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
    .replace(/^```json/i, "```")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  const a = t.indexOf("{"),
    b = t.lastIndexOf("}");
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

// تحويل 1.23e+4 إلى صيغة LaTeX 1.23×10^{4}
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
  if (Array.isArray(obj.givens))
    obj.givens = obj.givens.map((g) => ({ ...g, value: fix(g.value) }));
  if (Array.isArray(obj.unknowns))
    obj.unknowns = obj.unknowns.map((u) => ({ ...u, value: fix(u.value) }));
}

// تغليف الرموز بـ $...$ إن لم تكن مغلّفة مسبقًا
function wrapLatexSymbols(obj, fields) {
  fields.forEach((f) => {
    const arr = obj[f];
    if (!Array.isArray(arr)) return;
    obj[f] = arr.map((item) => {
      const sym = (item?.symbol ?? "") + "";
      const has = /^\$.*\$$/.test(sym);
      return { ...item, symbol: has ? sym : sym ? `$${sym}$` : sym };
    });
  });
}

/* --------------- Prompt Builder --------------- */
function buildPrompt(action, subject, concept, question) {
  const BASE = `أنت خبيرة ${subject}.
اكتبي بالعربية الفصحى فقط.
التزمي STRICTLY بالمفهوم المطلوب: «${concept}».
اكتبي الوحدات داخل \\mathrm{...} فقط: \\mathrm{N}, \\mathrm{kg}, \\mathrm{m/s^2}.
استخدمي LaTeX للمعادلات والرموز داخل $...$ أو $$...$$.
القيم العلمية الكبيرة بصيغة a\\times10^{n} وليس e-notation.
أعيدي كائن JSON صالحًا فقط وبدون أي نص خارج الأقواس.

المخططات المقبولة:
- explain: {"title":"string","overview":"string","symbols":[{"desc":"string","symbol":"string","unit":"string"}],"formulas":["string"],"steps":["string"]}
- example/example2/solve: {"scenario":"string","givens":[{"symbol":"string","value":"string","unit":"string","desc":"string"}],"unknowns":[{"symbol":"string","desc":"string"}],"formula":"string","steps":["string"],"result":"string"}
- practice: {"question":"string"}`;

  if (action === "explain") {
    return `${BASE}
أعيدي JSON لحالة explain فقط.
- "formulas" تخص «${concept}».
- "symbols": الوصف مختصر، الرمز (m, v_f, …)، الوحدة داخل \\mathrm{}.
- "steps": نقاط قصيرة مستقلّة.`;
  }

  if (action === "example") {
    return `${BASE}
أعيدي JSON لحالة example.
مستوى الصعوبة: متوسط. اختاري مجهولًا مناسبًا من متغيّرات «${concept}».
استخدمي قيماً منطقية ووحدات صحيحة. كل خطوة عنصر مستقل في "steps".`;
  }

  if (action === "example2") {
    return `${BASE}
أعيدي JSON لحالة example2.
اختاري مجهولًا مختلفًا عن المثال الأول لنفس «${concept}». التزمي بقوانينه فقط.`;
  }

  if (action === "practice") {
    return `${BASE}
أعيدي JSON لحالة practice فقط.
سؤال تدريب عربي من 2–3 جمل، مستوى متوسط، مع أعداد ووحدات بصيغة LaTeX.`;
  }

  if (action === "solve") {
    return `${BASE}
أعيدي JSON لحالة solve (نفس example) لهذه المسألة:
${question}

- رتّبي givens/unknowns بوحدات صحيحة.
- المعادلات داخل $...$ أو $$...$$.
- أظهري النتيجة النهائية في "result" بـ LaTeX مع الوحدة.`;
  }

  return `${BASE}\n{"error":"unknown action"}`;
}
