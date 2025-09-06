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

    // Gemini 1.5 Flash (JSON فقط)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: action === "practice" ? 0.65 : action === "example2" ? 0.55 : 0.35,
        maxOutputTokens: 950,
        response_mime_type: "application/json"
      }
    };

    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => null);

    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let data = tryParseJson(raw) || tryParseJson(extractJson(raw));

    // محاولة ترميم JSON عند الفشل
    if (!data) {
      const fixPayload = {
        contents: [{ role: "user", parts: [{ text:
`أصلحي JSON التالي ليطابق المخطط المطلوب حرفيًا.
أعيدي الكائن فقط بدون أي نص زائد:
${raw}` }]}],
        generationConfig: { temperature: 0.2, response_mime_type: "application/json" }
      };
      const rr = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(fixPayload) });
      const jj = await rr.json().catch(() => null);
      const raw2 = jj?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      data = tryParseJson(raw2) || tryParseJson(extractJson(raw2));
    }

    if (!data) return json({ ok:false, error:"Bad JSON from model" }, 502);

    // --- تحسينات عرض: منع صيغة e، والسماح بـ LaTeX في الرموز والوحدات ---
    tidyPayloadNumbers(data);

    return json({ ok:true, data });
  } catch (err) {
    return json({ ok:false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ================= Helpers ================= */
function json(obj, status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type":"application/json; charset=utf-8" }
  });
}
async function safeJson(req){ try{ return await req.json(); } catch{ return {}; } }
function tryParseJson(s){ try{ return s && JSON.parse(s); } catch{ return null; } }
function extractJson(text){
  if(!text) return "";
  let t = (text+"").trim()
    .replace(/^```json/i,"```")
    .replace(/^```/,"")
    .replace(/```$/,"")
    .trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a>=0 && b>a) t = t.slice(a, b+1);
  return t;
}

// حول القيم 5.0e+24 -> $5.0\\times10^{24}$ (لعرض أجمل)
function toLatexSci(x){
  const s = (x??"")+"";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if(!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/,"$1$2"); // تنعيم
  const exp = parseInt(m[2],10);
  return `$${mant}\\times10^{${exp}}$`;
}

function tidyPayloadNumbers(obj){
  const fixV = (v)=> toLatexSci(v);
  if (Array.isArray(obj.givens)){
    obj.givens = obj.givens.map(g => ({ ...g, value: fixV(g.value) }));
  }
  if (Array.isArray(obj.unknowns)){
    obj.unknowns = obj.unknowns.map(u => ({ ...u })); // لا شيء الآن
  }
  // أحيانًا ترجع "steps" بأرقام وصيغة e داخل النص—لا نلمسها لأنها تُعرض بMathJax تلقائيًا
}

/* ================= Prompt Builder ================= */
function buildPrompt(action, subject, concept, question){
  // قواعد صارمة للمحتوى حتى يلتزم بالمفهوم المطلوب، عربي فقط، وتنوع الأسئلة
  const BASE = `أنت خبيرة ${subject}.
اكتبي بالعربية الفصحى فقط (ممنوع الإنجليزية).
التزمي STRICTLY بالمفهوم المطلوب: «${concept}». لا تنتقلي إلى مفاهيم أخرى.
صيّغي الرموز بالحروف اللاتينية مع إمكانية استخدام سُفليّات LaTeX مثل m_1, v_f.
اكتبي الوحدات حصراً داخل \\mathrm{...} مثل: \\mathrm{N}, \\mathrm{kg}, \\mathrm{m/s^2}.
عند الحاجة لترميز الأعداد العلمية، استعملي LaTeX: $a\\times10^{n}$ وليس 1e+5.
أعيدي كائن JSON صحيح فقط بدون أي شرح أو نص خارجي.`;

  // مخطط الشرح (يرجِع رموز/وحدات منظمة)
  const EXPLAIN_SCHEMA =
    `{"title":"string","overview":"string","symbols":[{"desc":"string","symbol":"string","unit":"string"}],"formulas":["string"],"steps":["string"]}`;

  // مخطط مثال/حل
  const EXAMPLE_SCHEMA =
    `{"scenario":"string","givens":[{"symbol":"string","value":"string","unit":"string","desc":"string"}],"unknowns":[{"symbol":"string","desc":"string"}],"formula":"string","steps":["string"],"result":"string"}`;

  if (action === "explain"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${EXPLAIN_SCHEMA}
- اجعلي "formulas" تحتوي صيغ LaTeX صحيحة ومتصلة بالمفهوم فقط.
- اجعلي "symbols" مختصرة دقيقة (الوصف بالعربي، الرمز مثل F أو m_1، والوحدة داخل \\mathrm{...}).`;
  }

  if (action === "example"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${EXAMPLE_SCHEMA}
المستوى: متوسط. اختاري مجهولاً مناسبًا واحدًا.
استخدمي قيمًا عددية منطقية بوحداتها، وتجنّبي الأرقام التافهة.
اكتبي خطوات الحل كنص عربي، وأي معادلة داخل الخطوة بصيغة LaTeX بين $...$.
- المجهول المطلوب يجب أن يكون شائعاً ومناسباً للمبتدئين (مثال: القوة، السرعة، الزمن).`;
  }

  if (action === "example2"){
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${EXAMPLE_SCHEMA}
المستوى: فوق المتوسط بدرجة واحدة (خطوتان أو ثلاث خطوات اعتماد/اشتقاق).
- المجهول يجب أن يكون مختلفًا تماماً عن المجهول في المثال الأول.
- أكدي أن القانون/المعادلات كلها تخص «${concept}» تحديدًا.
- مثالي التنسيق للمجهول المختلف:
  - إذا كان المثال الأول يطلب $F$، اطلبي $m$ أو $a$.
  - إذا كان المثال الأول يطلب $m$، اطلبي $F$ أو $a$.
  - إذا كان المثال الأول يطلب $a$، اطلبي $F$ أو $m$.`;
  }

  if (action === "practice"){
    const PRACTICE_SCHEMA = `{"question":"string"}`;
    return `${BASE}
أعيدي JSON يطابق هذا المخطط: ${PRACTICE_SCHEMA}
اشرحي سؤال تدريب بالعربية فقط، من 2 إلى 3 جُمل، بمستوى صعوبة "متوسط".
غيّري السيناريو والمجهول في كل مرة (عشوائيًا بين متغيرات المفهوم الشائعة).
ضمّني أرقامًا ذات وحدات صحيحة بصيغة LaTeX (بدون e-notation).`;
  }

  if (action === "solve"){
    return `${BASE}
حلّي المسألة التالية بالتفصيل. املأي الحقول ببيانات الحل.
السؤال: ${question}
المخطط: ${EXAMPLE_SCHEMA}
- اجعلي "givens" و"unknowns" منظمة وواضحة.
- أظهري في "steps" الاشتقاقات بصيغة LaTeX داخل $...$ أو $$...$$.
- النتيجة النهائية في "result" بصيغة LaTeX بوحدة صحيحة.`;
  }

  return `${BASE}{"error":"unknown action"}`;
}
