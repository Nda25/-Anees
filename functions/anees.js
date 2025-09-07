// /netlify/functions/anees.js
// ============================================================================
// دالة Netlify تُولّد بيانات الفيزياء بصيغة JSON صالحة ومُنسَّقة للواجهة.
// - ثلاث طبقات حماية ضد Bad JSON (توليد صارم + إعادة صياغة + استخراج/تعقيم).
// - توحيد/تجميل القيم: لفّ الرموز والوحدات بـ LaTeX، تحويل e-notation إلى a×10^n.
// - ضمان أن لكل صفحة نفس البنية: scenario → givens/unknowns → formulas → steps → result.
// ============================================================================

export default async (req) => {
  try {
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
      return send({ ok: false, error: "أدخل/ي اسم القانون أو المفهوم." }, 400);
    }

    // 1) نبني البرومبت الدقيق وفق الإجراء المطلوب
    const prompt = buildPrompt(action, subject, concept, question);

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
      + `?key=${process.env.GEMINI_API_KEY}`;

    // إعدادات توليد تحفّز JSON نظيف (Mime-Type + حرارة منخفضة)
    const basePayload = {
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: 0.15,
        topP: 0.9,
        candidateCount: 1,
        maxOutputTokens: 900,
        response_mime_type: "application/json", // ← أهم سطر لإجبار JSON
        stopSequences: ["```", "\n\n\n"]
      }
    };

    // 2) الطلب الأول
    let raw = await callGemini(url, basePayload);
    let data = parseAsJson(raw);

    // 3) إن فشل: نرسل نص “أعيدي صياغة إلى JSON صالح 100%”
    if (!data) {
      const fixPayload = {
        contents: [{
          role: "user",
          parts: [{
            text:
`أعيدي صياغة المحتوى التالي إلى كائن JSON صالح 100٪ يطابق المخطط المطلوب تمامًا.
أعيدي الكائن فقط، بدون أي نص خارجي، وبدون Markdown.

${raw}`
          }]
        }],
        generationConfig: {
          temperature: 0.05,
          response_mime_type: "application/json"
        }
      };
      raw = await callGemini(url, fixPayload);
      data = parseAsJson(raw);
    }

    // 4) إن فشل أيضًا: محاولة استخلاص أقواس JSON وتعقيمها محليًا
    if (!data) {
      const extracted = extractJson(raw);
      data = parseAsJson(extracted) || parseAsJson(sanitizeJson(extracted));
    }

    // لو مازال فشل: نعيد خطأ واضح
    if (!data) {
      const snippet = (raw || "").slice(0, 350);
      return send({ ok: false, error: "Bad JSON from model", snippet }, 502);
    }

    // 5) تطبيع البنية: تأكد من الحقول، تحويل "formula" إلى "formulas" إن لزم
    normalizeSchema(data, action);

    // 6) تنظيف الخطوات (إزالة ترقيم يبدأ به النص)
    if (Array.isArray(data.steps)) {
      data.steps = data.steps
        .map(s => (s || "").toString().replace(/^\s*\d+[\)\.\:\-]\s*/, "").trim())
        .filter(Boolean);
    }

    // 7) لفّ الرموز بـ LaTeX إن لم تكن ملفوفة مسبقًا
    wrapLatexSymbols(data, ["symbols", "givens", "unknowns"]);

    // 8) تحويل e-notation إلى a×10^n (LaTeX) في القيم
    fixSciNumbers(data);

    // 9) لفّ الوحدات كلها داخل $...$ لضمان عرضها رياضيًا
    ensureUnitsLatex(data);

    // 10) إرجاع الحمولة النهائية الجاهزة للواجهة
    return send({ ok: true, data });

  } catch (err) {
    return send({ ok: false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ============================ أدوات أساسية ============================ */
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
    // نعيد رسالة مفيدة بدل صمت
    throw new Error(`HTTP ${r.status} — ${t.slice(0, 200)}`);
  }
  const j = await r.json().catch(() => null);
  // المسار القياسي لاستخراج النص من رد Gemini
  return j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
function parseAsJson(s) {
  try {
    if (!s) return null;
    let t = (s + "").trim();
    // إزالة أي تعليم Markdown
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
    .replace(/\s+\n/g, "\n")
    .trim();
}

/* ======================= تطبيع البنية والمعطيات ======================= */
// توحيد المخطط كي تفهمه الواجهة دومًا
function normalizeSchema(d, action) {
  // explain: نتأكد من الحقول
  if (action === "explain") {
    d.title   = (d.title   ?? "").toString().trim();
    d.overview= (d.overview?? "").toString().trim();
    if (!Array.isArray(d.formulas))   d.formulas = d.formula ? [d.formula] : [];
    if (!Array.isArray(d.symbols))    d.symbols  = [];
    if (!Array.isArray(d.steps))      d.steps    = [];
    // عناصر الرموز ككائنات منظمة
    d.symbols = d.symbols.map(s => ({
      desc:   (s.desc   ?? s.description ?? s.name ?? "").toString(),
      symbol: (s.symbol ?? s.sym ?? "").toString(),
      unit:   (s.unit   ?? "").toString()
    }));
  } else {
    // example/example2/solve
    if (!Array.isArray(d.formulas)) d.formulas = d.formula ? [d.formula] : [];
    if (!Array.isArray(d.givens))   d.givens  = [];
    if (!Array.isArray(d.unknowns)) d.unknowns= [];
    if (!Array.isArray(d.steps))    d.steps   = [];
    d.scenario = (d.scenario ?? d.question ?? "").toString().trim();
    d.result   = (d.result   ?? "").toString().trim();

    d.givens   = d.givens.map(g => ({
      symbol: (g.symbol ?? "").toString(),
      value:  (g.value  ?? "").toString(),
      unit:   (g.unit   ?? "").toString(),
      desc:   (g.desc   ?? g.description ?? "").toString()
    }));
    d.unknowns = d.unknowns.map(u => ({
      symbol: (u.symbol ?? "").toString(),
      desc:   (u.desc   ?? u.description ?? "").toString()
    }));
  }
}

/* ======================= تحويل e-notation إلى LaTeX ======================= */
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
  if (Array.isArray(obj.givens)) {
    obj.givens = obj.givens.map(g => ({ ...g, value: fix(g.value) }));
  }
  if (Array.isArray(obj.unknowns)) {
    obj.unknowns = obj.unknowns.map(u => ({ ...u, value: fix(u.value) }));
  }
}

/* ======================= لفّ الرموز والوحدات بـ LaTeX ======================= */
function wrapLatexSymbols(obj, fields) {
  const wrap = (s) => {
    const t = (s ?? "") + "";
    if (!t) return t;
    return /^\$.*\$$/.test(t) ? t : `$${t}$`;
  };
  fields.forEach(f => {
    const arr = obj[f];
    if (!Array.isArray(arr)) return;
    obj[f] = arr.map(item => {
      const sym = (item?.symbol ?? "");
      return { ...item, symbol: sym ? wrap(sym) : sym };
    });
  });
}
function ensureUnitsLatex(obj) {
  const wrap = (u) => {
    const s = (u ?? "").toString().trim();
    if (!s) return s;
    // لو جاءت على شكل \mathrm{} فقط، نغلفها بالدولار
    return /^\$.*\$$/.test(s) ? s : `$${s}$`;
  };
  // explain
  if (Array.isArray(obj.symbols)) {
    obj.symbols = obj.symbols.map(it => ({ ...it, unit: wrap(it.unit) }));
  }
  // examples & solve
  if (Array.isArray(obj.givens)) {
    obj.givens = obj.givens.map(it => ({ ...it, unit: wrap(it.unit) }));
  }
  if (Array.isArray(obj.unknowns)) {
    obj.unknowns = obj.unknowns.map(it => ({ ...it, unit: wrap(it.unit) }));
  }
}

/* ========================== مُنشئ البرومبت الدقيق ========================== */
function buildPrompt(action, subject, concept, question) {
  const BASE =
`أنت خبيرة ${subject} بالعربية الفصحى فقط (ممنوع الإنجليزية).
التزمي STRICTLY بالمفهوم: «${concept}».
استخدمي LaTeX للرموز والمعادلات داخل $...$ أو $$...$$.
الوحدات داخل \\mathrm{...} ثم لَفّيها كلها داخل $...$ (مثال: $\\mathrm{m/s^2}$).
الأعداد العلمية بصيغة a\\times10^{n} فقط (ممنوع e-notation).
أعيدي كائن JSON صالح 100٪ بدون أي Markdown أو نص زائد.

المخططات المقبولة:
- explain:
  {"title":"string","overview":"string","symbols":[{"desc":"string","symbol":"string","unit":"string"}],"formulas":["string"],"steps":["string"]}

- example / example2 / solve:
  {"scenario":"string","givens":[{"symbol":"string","value":"string","unit":"string","desc":"string"}],"unknowns":[{"symbol":"string","desc":"string"}],"formulas":["string"],"steps":["string"],"result":"string"}

- practice:
  {"question":"string"}`;

  // توجيهات مشتركة للمسائل
  const EX_HINT =
`- scenario: فقرتان عربيتان واضحتان (2–3 جمل) بلا معادلات، يصف الحالة بالأرقام والوحدات.
- derivation: استخرجي المعطيات (givens) والمجهول (unknowns) من السيناريو نفسه.
- formulas: القوانين المستخدمة (كل قانون سطر مستقل بصيغة $$...$$).
- steps: خطوات قصيرة منفصلة (كل خطوة بند مستقل).
- result: النتيجة النهائية بصيغة LaTeX بالرّمز والوحدة.`;

  if (action === "explain") {
    return `${BASE}
أعيدي explain فقط. اجعلي:
- "title" اسم المفهوم.
- "formulas" معادلات «${concept}» بصيغة $$...$$.
- "symbols": عناصر على شكل (desc, symbol, unit).
- "steps": نقاط إرشادية قصيرة.`;
  }
  if (action === "example") {
    return `${BASE}
أعيدي example فقط لمفهوم «${concept}».
${EX_HINT}
- اختاري مجهولًا شائعًا لهذا المفهوم.`;
  }
  if (action === "example2") {
    return `${BASE}
أعيدي example2 فقط لنفس المفهوم «${concept}» مع مجهول مختلف عن المثال الأول.
${EX_HINT}`;
  }
  if (action === "practice") {
    return `${BASE}
أعيدي practice فقط.
- "question": نص عربي كامل من سطرين يضم أرقامًا مع وحداتها (داخل LaTeX). لا تكتبي الحل.`;
  }
  if (action === "solve") {
    return `${BASE}
أعيدي solve فقط (نفس بنية example).
السؤال:\n${question}
${EX_HINT}`;
  }
  return `${BASE}\n{"error":"unknown action"}`;
}
