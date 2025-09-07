// functions/anees.js
// ====================================================================
// Netlify Function: يولّد المحتوى بصيغة JSON سليمة ويصلّح الشذوذات.
// - يمنع Bad JSON via: response_mime_type, إصلاح آلي, إصلاح محلي
// - يضمن عربية المحتوى
// - يعيد ترتيب الرموز/الوحدات ويصلّح scientific notation
// ====================================================================

export default async (req) => {
  try {
    const KEY = process.env.GEMINI_API_KEY;
    if (!KEY) return send({ ok: false, error: "Missing GEMINI_API_KEY" }, 500);

    const body = await safeJson(req);
    const {
      action = "explain",
      subject = "الفيزياء",
      concept = "",
      question = ""
    } = body || {};

    if (!concept?.trim())
      return send({ ok: false, error: "أدخلي اسم القانون/المفهوم." }, 400);

    // 1) جهّز البرومبت والحمولة الأساسية
    const prompt = buildPrompt(action, subject, concept, question);

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
      KEY;

    const basePayload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1100,
        candidateCount: 1,
        // أهم سطرين لمنع “Bad JSON” من الأصل:
        response_mime_type: "application/json",
        stopSequences: ["```", "\n\n\n"]
      }
    };

    // 2) الطلب الأول
    let raw = await callGemini(url, basePayload);
    let data = parseAsJson(raw);

    // 3) “تصليح JSON” بواسطة الموديل إن فشل الأول
    if (!data) {
      const fixPayload = {
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "أعيدي صياغة المحتوى التالي إلى JSON صالح 100% يطابق المخطط المطلوب فقط،" +
                  " بدون أي نص خارجي أو Markdown:\n\n" +
                  raw
              }
            ]
          }
        ],
        generationConfig: { temperature: 0.1, response_mime_type: "application/json" }
      };
      raw = await callGemini(url, fixPayload);
      data = parseAsJson(raw);
    }

    // 4) محاولة استخلاص/تعقيم محلية أخيرة
    if (!data) {
      const extracted = extractJson(raw);
      data = parseAsJson(extracted) || parseAsJson(sanitizeJson(extracted));
    }

    if (!data) {
      // ما زال غير صالح: أرجع رسالة واضحة للواجهة (راح تظهر في الشريط الأحمر)
      return send({ ok: false, error: "Bad JSON from model" }, 502);
    }

    // 5) التحقق من العربية — و إعادة توليد/ترجمة إذا لزم
    if (!isArabicEnough(JSON.stringify(data))) {
      const translatePayload = {
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "حوّلي هذا الكائن إلى **عربية فصحى** مع الحفاظ على نفس البنية والقيم،" +
                  " وأعيدي JSON فقط:\n\n" + JSON.stringify(data)
              }
            ]
          }
        ],
        generationConfig: { temperature: 0.1, response_mime_type: "application/json" }
      };
      const trRaw = await callGemini(url, translatePayload);
      const trJson = parseAsJson(trRaw);
      if (trJson) data = trJson;
    }

    // 6) توحيد الهيكل حسب نوع الإجراء + إصلاحات الوحدات/الأعداد
    data = normalizeByAction(data, action);

    return send({ ok: true, data });
  } catch (err) {
    return send({ ok: false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ============================ Utilities ============================ */

function send(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function safeJson(req) {
  try { return await req.json(); } catch { return {}; }
}

async function callGemini(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
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
    let t = (s + "").trim();
    // تنظيف أي ```json … ``` محتمل
    t = t.replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();
    return JSON.parse(t);
  } catch { return null; }
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
    .trim();
}

/* ==================== Arabic & Number/Units helpers ==================== */

function isArabicEnough(s) {
  const only = (s || "").replace(/[^\u0600-\u06FF]+/g, "");
  return only.length >= Math.min(20, Math.ceil((s || "").length * 0.25));
}

function sciToLatex(v) {
  const s = (v ?? "") + "";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if (!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/, "$1$2");
  const exp = parseInt(m[2], 10);
  if (exp === 0) return mant;                  // ← لا نكتب ×10^0
  return `$${mant}\\times10^{${exp}}$`;
}

function looksLikeUnit(s) {
  s = (s ?? "") + "";
  return /\\mathrm\{|m\/s|m\^2|s\^2|kg|N|J|Pa|W|Hz|A|K|rad|m|s|V|C|Ω|ohm/i.test(s);
}

function fixSciNumbers(obj) {
  const convert = (x) => {
    if (typeof x === "number") return sciToLatex(x);
    const sx = (x ?? "") + "";
    if (/^\s*[+-]?\d+(?:\.\d+)?e[+-]?\d+\s*$/i.test(sx)) return sciToLatex(sx);
    return x;
  };
  if (Array.isArray(obj.givens))
    obj.givens = obj.givens.map(g => ({ ...g, value: convert(g.value) }));
  if (Array.isArray(obj.unknowns))
    obj.unknowns = obj.unknowns.map(u => ({ ...u, value: convert(u.value) }));
}

// ينقل أي وحدة “هاربة” من الوصف إلى عمود unit ويضمن لفّها في MathJax بالدولار
function normalizeUnitsRow(row) {
  const r = { ...row };
  if (!r.unit && looksLikeUnit(r.desc)) { r.unit = r.desc; r.desc = "—"; }
  // لا نضيف \mathrm هنا — الواجهة ستلف بالدولار وتنسّق
  return r;
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

/* ========================== Prompt Builder ========================== */

function buildPrompt(action, subject, concept, question) {
  const BASE = `
أنت خبيرة ${subject}.
اكتبي بالعربية الفصحى فقط (ممنوع الإنجليزية).
التزمي STRICTLY بالمفهوم: «${concept}».
استخدمي LaTeX للمعادلات داخل $...$ أو $$...$$ فقط.
اكتبي الوحدات كنص عادي واضح مثل m/s^2, kg, N (بدون \\mathrm في النص نفسه).
القيم العلمية: a×10^{n} وليس e-notation.
أعيدي كائن JSON صالح 100٪ فقط — بدون Markdown ولا شروح خارجية.

المخططات المقبولة:
- explain:
  {"title":"string","overview":"string","symbols":[{"desc":"string","symbol":"string","unit":"string"}],"formulas":["string"],"steps":["string"]}
- example/example2/solve:
  {"scenario":"string","givens":[{"symbol":"string","value":"string","unit":"string","desc":"string"}],"unknowns":[{"symbol":"string","desc":"string"}],"formula":"string","formulas":["string"],"steps":["string"],"result":"string"}
- practice:
  {"question":"string"}
`.trim();

  if (action === "explain")
    return `${BASE}
أعيدي JSON لحالة explain فقط. اجعلي "formulas" خاصة بـ «${concept}»، وجدول "symbols" مرتّب (الوصف، الرمز، الوحدة).`;

  if (action === "example")
    return `${BASE}
أعيدي JSON لحالة example. مستوى متوسط، اختاري مجهولًا مناسبًا من متغيّرات «${concept}». اذكري خطوات مرتّبة، واستعملي قيمًا منطقية (بوحداتها).`;

  if (action === "example2")
    return `${BASE}
أعيدي JSON لحالة example2. غيري المطلوب عن المثال المعتاد لنفس «${concept}». نفس البنية بدقة، وخطوات واضحة عربية.`;

  if (action === "practice")
    return `${BASE}
أعيدي JSON لحالة practice فقط. اكتبي سؤالًا عربيًا من سطرين إلى ثلاثة، واضحًا، وستُستخرج منه المعطيات والمجاهيل لاحقًا.`;

  if (action === "solve")
    return `${BASE}
أعيدي JSON لحالة solve. السؤال:\n${question}\n
نظّمي givens/unknowns بوحدات صحيحة، وأظهري النتيجة النهائية في "result" بصيغة LaTeX.`;

  return `${BASE}\n{"error":"unknown action"}`;
}

/* ====================== Schema Normalization ====================== */

function ensureArray(x) { return Array.isArray(x) ? x : (x ? [x] : []); }

function normalizeByAction(data, action) {
  // توحيد الحقول الشائعة
  if (action === "explain") {
    data.title = (data.title || "").toString().trim();
    data.overview = (data.overview || "").toString().trim();
    data.formulas = ensureArray(data.formulas);
    data.symbols = ensureArray(data.symbols).map(normalizeUnitsRow);
    data.steps = ensureArray(data.steps).map(cleanStep);
    return data;
  }

  if (action === "practice") {
    data.question = (data.question || "").toString().trim();
    return data;
  }

  // example / example2 / solve
  data.scenario = (data.scenario || data.question || "").toString().trim();
  data.givens = ensureArray(data.givens).map(normalizeUnitsRow);
  data.unknowns = ensureArray(data.unknowns).map(normalizeUnitsRow);
  data.formulas = ensureArray(data.formulas || data.formula);
  data.steps = ensureArray(data.steps).map(cleanStep);
  data.result = (data.result || "").toString().trim();

  // تحسينات رقمية/وحدات
  wrapLatexSymbols(data, ["givens", "unknowns"]);
  fixSciNumbers(data);

  // ضمان وجود مفاتيح مطلوبة
  if (!data.formulas.length && data.result) {
    // في أسوأ الأحوال، استخرجي المعادلة من النتيجة إن أمكن
    data.formulas = [data.result];
  }
  return data;
}

function cleanStep(s) {
  return (s || "").toString().replace(/^\s*\d+[\)\.\-:]\s*/, "").trim();
}
