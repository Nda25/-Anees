// functions/anees.js
export default async (req) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return j({ ok:false, error:"Missing GEMINI_API_KEY" }, 500);

    const body = await safeJson(req);
    const { action = "explain", subject = "الفيزياء", concept = "", question = "" } = body || {};
    if (!concept) return j({ ok:false, error:"أدخلي اسم القانون/المفهوم." }, 400);

    const { url, payload } = buildCall(GEMINI_API_KEY, action, subject, concept, question);

    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
    const j = await r.json().catch(()=>null);
    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    let data = tryParse(raw) || tryParse(extractJson(raw)) || tryParse(sanitizeJson(extractJson(raw)));

    if (!data) {
      const fixPayload = {
        contents: [{ role:"user", parts:[{ text:
`أصلحي JSON التالي ليكون صالحًا 100٪ ويطابق المخطط المطلوب.
أعيدي الكائن فقط بلا أي كودات أو شرح:

${raw}` }]}],
        generationConfig:{ temperature:0.2, response_mime_type:"application/json" }
      };
      const rr = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(fixPayload) });
      const jj = await rr.json().catch(()=>null);
      const raw2 = jj?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      data = tryParse(raw2) || tryParse(extractJson(raw2)) || tryParse(sanitizeJson(extractJson(raw2)));
    }

    if (!data) return j({ ok:false, error:"Bad JSON from model" }, 502);

    // معالجة الرموز والترقيم بشكل أفضل
    if (data.steps) {
        data.steps = data.steps.map(s => s.replace(/^\s*\d+\.\s*/, '').trim());
    }
    if (data.symbols) {
        data.symbols = data.symbols.map(s => ({
            ...s,
            symbol: s.symbol.startsWith('$') && s.symbol.endsWith('$') ? s.symbol : `$${s.symbol}$`
        }));
    }
    if (data.givens) {
        data.givens = data.givens.map(g => ({
            ...g,
            symbol: g.symbol.startsWith('$') && g.symbol.endsWith('$') ? g.symbol : `$${g.symbol}$`
        }));
    }
    if (data.unknowns) {
        data.unknowns = data.unknowns.map(u => ({
            ...u,
            symbol: u.symbol.startsWith('$') && u.symbol.endsWith('$') ? u.symbol : `$${u.symbol}$`
        }));
    }

    tidyPayloadNumbers(data);

    return j({ ok:true, data });

  } catch (err) {
    return j({ ok:false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ================= Helpers ================= */
function j(obj, status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers:{ "Content-Type":"application/json; charset=utf-8" }
  });
}
async function safeJson(req){ try{ return await req.json(); }catch{ return {}; } }
function tryParse(s){ try{ return s && JSON.parse(s); }catch{ return null; } }
function extractJson(text){
  if (!text) return "";
  let t = (text+"")
    .replace(/\uFEFF/g,"")
    .replace(/[\u200E\u200F\u202A-\u202E]/g,"")
    .trim()
    .replace(/^```json/i,"```")
    .replace(/^```/,"")
    .replace(/```$/,"")
    .trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a>=0 && b>a) t = t.slice(a, b+1);
  return t;
}
function sanitizeJson(t){
  return (t||"")
    .replace(/[“”]/g,'"')
    .replace(/[‘’]/g,"'")
    .replace(/,\s*([}\]])/g,"$1")
    .replace(/:\s*undefined/g,": null")
    .replace(/\s+\n/g,"\n")
    .trim();
}
function sciToLatex(v){
  const s = (v??"")+"";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if(!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/,"$1$2");
  const exp = parseInt(m[2],10);
  return `$${mant}\\times10^{${exp}}$`;
}
function tidyPayloadNumbers(obj){
  const fix = (x)=> {
    if (typeof x === "number") return sciToLatex(x);
    if (/^\s*[+-]?\d+(\.\d+)?e[+-]?\d+\s*$/i.test((x||"")+"")) return sciToLatex(x);
    return x;
  };
  if (Array.isArray(obj.givens)) obj.givens = obj.givens.map(g => ({ ...g, value: fix(g.value) }));
  if (Array.isArray(obj.unknowns)) obj.unknowns = obj.unknowns.map(u => ({ ...u }));
}

/* ================= Prompt Builder ================= */
function buildPrompt(action, subject, concept, question){
  const BASE = `أنت خبيرة ${subject}.
اكتبي بالعربية الفصحى فقط (ممنوع الإنجليزية).
التزمي STRICTLY بالمفهوم المطلوب: «${concept}» ولا تنتقلي لغيره.
اكتبي الوحدات داخل \\mathrm{...} حصرًا: \\mathrm{N}, \\mathrm{kg}, \\mathrm{m/s^2} ...
استعملي ترميز LaTeX داخل $...$ أو $$...$$ للمعادلات والرموز ذات السفلية (m_1, v_f).
القيم العددية الكبيرة اكتبيها بصيغة LaTeX العلمية (a\\times10^{n}) لا بصيغة e.
أعيدي كائن JSON صالح فقط بدون أي شرح أو أسطر زائدة.`;
  const EXPLAIN_SCHEMA = `{"title":"string","overview":"string","symbols":[{"desc":"string","symbol":"string","unit":"string"}],"formulas":["string"],"steps":["string"]}`;
  const EXAMPLE_SCHEMA = `{"scenario":"string","givens":[{"symbol":"string","value":"string","unit":"string","desc":"string"}],"unknowns":[{"symbol":"string","desc":"string"}],"formula":"string","steps":["string"],"result":"string"}`;
  const PRACTICE_SCHEMA = `{"question":"string"}`;
  if (action === "explain"){
    return `${BASE}\nأعيدي JSON يطابق هذا المخطط: ${EXPLAIN_SCHEMA}\n- اجعلي "formulas" صحيحة وتتعلق فقط بـ «${concept}».\n- اجعلي "symbols" مختصرة: (desc عربي واضح، symbol مثل F أو m_1، unit داخل \\mathrm{...}).\n- اجعلي "steps" قائمة بنقاط منفصلة (كل نقطة خطوة منفصلة).`;
  }
  if (action === "example"){
    return `${BASE}\nأعيدي JSON يطابق هذا المخطط: ${EXAMPLE_SCHEMA}\nالمستوى: متوسط. اختاري مجهولًا مناسبًا واحدًا لهذا المفهوم.\nاستخدمي قيَمًا منطقية ووحدات صحيحة. اشرحي الخطوات بالعربية، وأي معادلة داخل $...$.\n- اجعلي كل خطوة في عنصر منفصل داخل مصفوفة "steps".`;
  }
  if (action === "example2"){
    return `${BASE}\nأعيدي JSON يطابق هذا المخطط: ${EXAMPLE_SCHEMA}\nالمستوى: فوق المتوسط بدرجة (خطوات اعتماد/اشتقاق إضافية).\nاختاري مجهولًا مختلفًا عن المثال الشائع لنفس المفهوم (متغير آخر من نفس القانون).\nتأكدي أن القانون والصيغ تخص «${concept}» تحديدًا.\n- اجعلي كل خطوة في عنصر منفصل داخل مصفوفة "steps".`;
  }
  if (action === "practice"){
    return `${BASE}\nأعيدي JSON يطابق هذا المخطط: ${PRACTICE_SCHEMA}\nاكتبي سؤال تدريب عربي فقط من 2–3 جُمل، بمستوى "متوسط".\nغيّري السيناريو والمجهول في كل مرة (عشوائيًا بين متغيرات المفهوم الشائعة).\nضمّني أعدادًا مع وحداتها الصحيحة بصيغة LaTeX، وامتنعي عن e-notation نهائيًا.`;
  }
  if (action === "solve"){
    return `${BASE}\nحلّي المسألة التالية وأعيدي JSON يطابق مخطط المثال: ${EXAMPLE_SCHEMA}\nالسؤال: ${question}\n- رتّبي givens/unknowns بدقة ووحدات صحيحة.\n- اجعلي Steps بالعربية وأي معادلة داخل $...$ أو $$...$$.\n- ضعي النتيجة النهائية في "result" بصيغة LaTeX مع الوحدة.\n- اجعلي كل خطوة في عنصر منفصل داخل مصفوفة "steps".`;
  }
  return `${BASE}{"error":"unknown action"}`;
}
