// functions/anees.js
export default async (req) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return send({ ok: false, error: "Missing GEMINI_API_KEY" }, 500);

    const body = await safeJson(req);
    const {
      action = "explain",
      subject = "الفيزياء",
      concept = "",
      question = ""
    } = body || {};
    if (!concept) return send({ ok: false, error: "أدخلي اسم القانون/المفهوم." }, 400);

    // نبني البرومبت
    const prompt = buildPrompt(action, subject, concept, question);

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
      process.env.GEMINI_API_KEY;

    // الطلب الأساسي — نطلب JSON صِرف
    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        candidateCount: 1,
        maxOutputTokens: 1000,
        response_mime_type: "application/json"
      },
      // نقلّل من تدخلات السلامة التي قد تغيّر البنية
      safetySettings: []
    };

    let raw = await callGemini(url, payload);
    let data = parseAsJson(raw);

    // محاولة إصلاح رقم 1: اقتطاع أول {...} وآخره
    if (!data) {
      const extracted = extractJson(raw);
      data = parseAsJson(extracted) || parseAsJson(sanitizeJson(extracted));
    }

    // محاولة إصلاح رقم 2: نطلب من النموذج تصحيح النص إلى JSON فقط
    if (!data) {
      const fixPayload = {
        contents: [{
          role: "user",
          parts: [{
            text:
`أعيدي صياغة المُدخل التالي إلى كائن JSON صالح 100٪ يطابق أحد المخططات المحدّدة. 
أعيدي الكائن فقط، بدون أي نص خارجي أو Markdown.

${raw}`
          }]
        }],
        generationConfig: { temperature: 0.1, response_mime_type: "application/json" },
        safetySettings: []
      };
      raw = await callGemini(url, fixPayload);
      const extracted = extractJson(raw);
      data = parseAsJson(extracted) || parseAsJson(sanitizeJson(extracted)) || parseAsJson(raw);
    }

    if (!data) {
      return send({ ok: false, error: "Bad JSON from model", snippet: (raw || "").slice(0, 400) }, 502);
    }

    // نضمن الحقول الأساسية حسب الإجراء
    normalizeByAction(action, data);

    // تنظيف الوحدات من \mathrm{}
    stripMathrmUnits(data);

    // تغليف الرموز بـ $...$ (فقط الرموز)
    wrapLatexSymbols(data, ["symbols", "givens", "unknowns"]);

    // تحويل أرقام e-notation إلى LaTeX
    fixSciNumbers(data);

    // تنعيم خطوات مرقّمة ترجع من النموذج
    if (Array.isArray(data.steps)) {
      data.steps = data.steps
        .map(s => (s || "").toString().replace(/^\s*\d+[\).\-\:]\s*/, "").trim())
        .filter(Boolean);
    }

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
  // Gemini يرجع النص في candidates[0].content.parts[0].text
  return j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

function parseAsJson(s) {
  try {
    if (!s) return null;
    let t = (s + "").trim();
    t = t.replace(/^```json/i, "```")
         .replace(/^```/, "")
         .replace(/```$/, "")
         .trim();
    return JSON.parse(t);
  } catch { return null; }
}

function extractJson(text) {
  if (!text) return "";
  let t = (text + "")
    .replace(/\uFEFF/g, "")
    .replace(/[\u200E\u200F\u202A-\u202E]/g, "")
    .replace(/^```json/i, "```")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return (a >= 0 && b > a) ? t.slice(a, b + 1) : t;
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

// إزالة \mathrm{...} من الوحدات أينما ظهرت
function stripMathrmUnits(obj) {
  const clean = (u) => (u || "").toString().replace(/\\mathrm\s*\{([^}]+)\}/g, "$1").trim();
  if (Array.isArray(obj.symbols)) obj.symbols = obj.symbols.map(x => ({ ...x, unit: clean(x.unit) }));
  if (Array.isArray(obj.givens))  obj.givens  = obj.givens.map(x  => ({ ...x, unit: clean(x.unit) }));
  if (Array.isArray(obj.unknowns)) obj.unknowns = obj.unknowns.map(x=> ({ ...x, unit: clean(x.unit) }));
}

function sciToLatex(v) {
  const s = (v ?? "") + "";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if (!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/, "$1$2");
  const exp  = parseInt(m[2], 10);
  return `$${mant}\\times10^{${exp}}$`;
}

// نطبّق التحويل فقط على "value" داخل givens/unknowns
function fixSciNumbers(obj) {
  const fix = (x) => {
    if (typeof x === "number") return sciToLatex(x);
    const sx = (x ?? "") + "";
    if (/^\s*[+-]?\d+(\.\d+)?e[+-]?\d+\s*$/i.test(sx)) return sciToLatex(sx);
    return x;
  };
  if (Array.isArray(obj.givens))   obj.givens   = obj.givens.map(g => ({ ...g, value: fix(g.value) }));
  if (Array.isArray(obj.unknowns)) obj.unknowns = obj.unknowns.map(u => ({ ...u, value: fix(u.value) }));
}

// نغلّف الرموز فقط بـ $...$ (الوحدات تظل نص عادي)
function wrapLatexSymbols(obj, fields) {
  fields.forEach(f => {
    const arr = obj[f];
    if (!Array.isArray(arr)) return;
    obj[f] = arr.map(item => {
      const sym = ((item && item.symbol) || "") + "";
      const already = /^\$.*\$$/.test(sym);
      return { ...item, symbol: already ? sym : (sym ? `$${sym}$` : sym) };
    });
  });
}

// ضمان البنية حسب الإجراء
function normalizeByAction(action, d) {
  if (action === "explain") {
    d.title    = d.title    ?? "";
    d.overview = d.overview ?? "";
    d.formulas = Array.isArray(d.formulas) ? d.formulas : (d.formula ? [d.formula] : []);
    d.symbols  = Array.isArray(d.symbols)  ? d.symbols  : [];
    d.steps    = Array.isArray(d.steps)    ? d.steps    : [];
  } else if (action === "practice") {
    d.question = d.question ?? "";
  } else { // example / example2 / solve
    d.scenario = d.scenario ?? d.question ?? "";
    d.givens   = Array.isArray(d.givens)   ? d.givens   : [];
    d.unknowns = Array.isArray(d.unknowns) ? d.unknowns : [];
    if (!Array.isArray(d.formulas) && d.formula) d.formulas = [d.formula];
    d.formula  = d.formula ?? (Array.isArray(d.formulas) ? d.formulas[0] : "");
    d.steps    = Array.isArray(d.steps)    ? d.steps    : [];
    d.result   = d.result   ?? "";
  }
}

/* --------------- Prompt Builder --------------- */
function buildPrompt(action, subject, concept, question) {
  const SCHEMAS = `
- explain: {"title":"string","overview":"string","symbols":[{"desc":"string","symbol":"string","unit":"string"}],"formulas":["string"],"steps":["string"]}
- example/example2/solve: {"scenario":"string","givens":[{"symbol":"string","value":"string","unit":"string","desc":"string"}],"unknowns":[{"symbol":"string","desc":"string"}],"formula":"string","steps":["string"],"result":"string"}
- practice: {"question":"string"}`;

  const BASE =
`أنت خبيرة ${subject}.
اكتبي بالعربية الفصحى فقط.
التزمي STRICTLY بالمفهوم المطلوب: «${concept}».
استخدمي LaTeX للمعادلات داخل $...$ أو $$...$$ للمعادلات فقط.
اكتبي الوحدات كنص عادي (مثل m/s أو N·m^2/kg^2) بدون \\mathrm{}.
الأعداد العلمية بصيغة a\\times10^{n} وليس e-notation.
أعيدي كائن JSON صالح 100٪ يطابق أحد المخططات التالية فقط، وبدون أي نص خارجي أو Markdown.
${SCHEMAS}
`;

  if (action === "explain") {
    return `${BASE}
أعيدي JSON لحالة explain فقط.
- "formulas": معادلات صحيحة تخص «${concept}».
- "symbols": صفوف مختصرة؛ الرمز (مثل v_0, a, g)؛ الوحدة نص عادي (kg, m/s^2).
- "steps": نقاط قصيرة وواضحة.`;
  }
  if (action === "example") {
    return `${BASE}
أعيدي JSON لحالة example.
اختاري مجهولًا طبيعيًا من متغيّرات «${concept}»، بقيم منطقية ووحدات صحيحة.
كل خطوة عنصر مستقل في "steps".`;
  }
  if (action === "example2") {
    return `${BASE}
أعيدي JSON لحالة example2.
اختاري مجهولًا مختلفًا عن المثال السابق لنفس «${concept}».
التزمي بالقانون الصحيح فقط. كل خطوة عنصر مستقل.`;
  }
  if (action === "practice") {
    return `${BASE}
أعيدي JSON لحالة practice فقط.
اكتبي سؤال تدريب عربي من 2–3 جمل بقيم منطقية ووحدات صحيحة.`;
  }
  if (action === "solve") {
    return `${BASE}
أعيدي JSON لحالة solve (نفس بنية example).
السؤال: ${question}
نظّمي givens/unknowns بوحدات صحيحة، والمعادلات بصيغة LaTeX. اظهري النتيجة النهائية في "result".`;
  }
  return `${BASE}\n{"error":"unknown action"}`;
}
