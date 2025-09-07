// functions/anees.js
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

    const prompt = buildPrompt(action, subject, concept, question);
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + KEY;
    const basePayload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: action === "practice" ? 0.65 : action === "example2" ? 0.55 : 0.35,
        maxOutputTokens: 1100,
        response_mime_type: "application/json",
        stopSequences: ["```"]
      }
    };

    let raw = await callGemini(url, basePayload);
    let data = parseAsJson(raw);

    if (!data) {
      const fixPayload = {
        contents: [{ role: "user", parts: [{ text: `أصلحي JSON التالي ليكون صالحًا 100٪ ويطابق المخطط المطلوب. أعيدي الكائن فقط:\n\n${raw}` }] }],
        generationConfig: { temperature: 0.1, response_mime_type: "application/json" }
      };
      raw = await callGemini(url, fixPayload);
      data = parseAsJson(raw);
    }

    if (!data) {
      const extracted = extractJson(raw);
      data = parseAsJson(extracted) || parseAsJson(sanitizeJson(extracted));
    }

    if (!data) {
      return send({ ok: false, error: "Bad JSON from model" }, 502);
    }

    // --- معالجة البيانات قبل الإرسال للواجهة
    data = normalizeByAction(data, action);
    wrapLatexSymbols(data, ["symbols", "givens", "unknowns"]);
    fixSciNumbers(data);

    return send({ ok: true, data });

  } catch (err) {
    return send({ ok: false, error: err?.message || "Unexpected error" }, 500);
  }
};

/* ============================ Utilities ============================ */
function send(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
async function safeJson(req) { try { return await req.json(); } catch { return {}; } }
async function callGemini(url, payload) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
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
    t = t.replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();
    return JSON.parse(t);
  } catch { return null; }
}
function extractJson(text) {
  if (!text) return "";
  let t = (text + "").replace(/\uFEFF/g, "").replace(/[\u200E\u200F\u202A-\u202E]/g, "").trim().replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}
function sanitizeJson(t) { return (t || "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1").replace(/:\s*undefined/g, ": null").trim(); }
function isArabicEnough(s) { const only = (s || "").replace(/[^\u0600-\u06FF]+/g, ""); return only.length >= Math.min(20, Math.ceil((s || "").length * 0.25)); }
function sciToLatex(v) {
  const s = (v ?? "") + "";
  const m = s.match(/^\s*([+-]?\d+(?:\.\d+)?)e([+-]?\d+)\s*$/i);
  if (!m) return s;
  const mant = m[1].replace(/^([+-]?)(\d+)\.0+$/, "$1$2");
  const exp = parseInt(m[2], 10);
  if (exp === 0) return mant;
  return `$${mant}\\times10^{${exp}}$`;
}
function looksLikeUnit(s) { return /\\mathrm\{|\/|\\^|\^|m\/s|kg|N|J|Pa|W|Hz|A|K|rad|m|s|V|C|Ω|ohm/i.test(s); }
function normalizeUnitsRow(row) {
  const r = { ...row };
  if (!r.unit && looksLikeUnit(r.desc)) { r.unit = r.desc; r.desc = "—"; }
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
function fixSciNumbers(obj) {
  const convert = (x) => {
    if (typeof x === "number") return sciToLatex(x);
    const sx = (x ?? "") + "";
    if (/^\s*[+-]?\d+(?:\.\d+)?e[+-]?\d+\s*$/i.test(sx)) return sciToLatex(sx);
    return x;
  };
  if (Array.isArray(obj.givens)) obj.givens = obj.givens.map(g => ({ ...g, value: convert(g.value) }));
  if (Array.isArray(obj.unknowns)) obj.unknowns = obj.unknowns.map(u => ({ ...u, value: convert(u.value) }));
}
function normalizeByAction(data, action) {
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
  data.scenario = (data.scenario || data.question || "").toString().trim();
  data.givens = ensureArray(data.givens).map(normalizeUnitsRow);
  data.unknowns = ensureArray(data.unknowns).map(normalizeUnitsRow);
  data.formulas = ensureArray(data.formulas || data.formula);
  data.steps = ensureArray(data.steps).map(cleanStep);
  data.result = (data.result || "").toString().trim();
  wrapLatexSymbols(data, ["givens", "unknowns"]);
  fixSciNumbers(data);
  if (!data.formulas.length && data.result) {
    data.formulas = [data.result];
  }
  return data;
}
function ensureArray(x) { return Array.isArray(x) ? x : (x ? [x] : []); }
function cleanStep(s) {
  return (s || "").toString().replace(/^\s*\d+[\)\.\-:]\s*/, "").trim();
}
