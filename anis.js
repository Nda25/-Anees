/* ========================================================================
   Frontend JS — العرض الموحّد لكل الصفحات + حماية تنسيقات LaTeX
   - MATH.htmlWithMath: يمرر LaTeX لـ MathJax بأمان (كتل $$...$$ وسطرية $...$).
   - normalizeRow: يكتشف إن كانت الوحدة انزلقت في "الوصف" ويعيدها لمكانها.
   - renderExplain / renderCase: قوالب متطابقة للجداول والقوانين والخطوات.
   - call(): يتصل بـ Netlify Function ويعرض رسائل مفيدة عند الخطأ.
   ======================================================================== */

/* ---------------------- Math helpers ---------------------- */

let selectedFormula = "";

const MATH = (() => {
  // تنظيف سريع لأي نص
  const clean = s => (s ?? "").toString().replace(/\r/g, "\n").trim();

  // نضيف backslash للدوال الشائعة لو نقصت (حذرًا من تلوّث رموز عربية)
  const fixLatex = (s) => clean(s).replace(/(^|[^\\])\b(frac|sqrt|mathrm|cdot)\b/g, '$1\\$2');

 function htmlWithMath(input) {
  let s = fixLatex(input || "");
  const blocks = [], inlines = [];

  // 1) نفك الهروب \$ -> $
  s = s.replace(/\\\$/g, '$');

  // 2) كتلة رياضية قبل الدولارات \[ ... \]
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => {
    blocks.push('$$' + inner + '$$');
    return '§§B' + (blocks.length - 1) + '§§';
  });

  // 3) سطرية قبل الدولارات \( ... \)
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => {
    inlines.push('$' + inner + '$');
    return '§§I' + (inlines.length - 1) + '§§';
  });

  // 4) التقاط $$...$$ (كتل)
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => {
    blocks.push('$$' + inner + '$$');
    return '§§B' + (blocks.length - 1) + '§§';
  });

  // 5) التقاط $...$ (سطرية)
  s = s.replace(/\$([^$]+)\$/g, (_, inner) => {
    inlines.push('$' + inner + '$');
    return '§§I' + (inlines.length - 1) + '§§';
  });

  // 5.5) الآن المعادلات مخبأة كبلايسهولدر — لفّي أي \mathrm{...} عارية فقط
  s = s.replace(/(\\mathrm\{[^}]+\})/g, (_m, mm) => `<span class="math-inline">$${mm}$</span>`);

  // 6) إعادة الحقن ليرسمها MathJax
  s = s
    .replace(/§§B(\d+)§§/g, (_, i) => `<div class="math-block">${blocks[i]}</div>`)
    .replace(/§§I(\d+)§§/g, (_, i) => `<span class="math-inline">${inlines[i]}</span>`);

  return s;
}

return { htmlWithMath };
})();

/* --------------------- تنسيق الصفوف/الوحدات --------------------- */
function hasMathDelim(s){ return /\$|\\\(|\\\[/.test(s||''); }
function wrapMath(s){ s=(s??'').toString().trim(); return !s ? s : (hasMathDelim(s) ? s : `$${s}$`); }
function probablyUnit(s){
  s=(s??'')+'';
  return /\\mathrm\{|\/|\\^|\^|m\/s|kg|N|J|Pa|W|Hz|m\^2|s\^2|A|K/i.test(s);
}

// خريطة عربية سريعة لأشهر الرموز
const SYMBOL_AR = {
  'v_f':'السرعة النهائية','vf':'السرعة النهائية',
  'v_i':'السرعة الابتدائية','vi':'السرعة الابتدائية',
  'v':'السرعة','a':'التسارع','g':'تسارع الجاذبية','t':'الزمن',
  'h':'الارتفاع','d':'المسافة','s':'الإزاحة','m':'الكتلة','F':'القوة'
};
function normalizeRow(obj){
  const o = { ...obj };

  // لو الوحدة هجرت للوصف نرجّعها
  if (!o.unit && probablyUnit(o.desc)) { o.unit = o.desc; o.desc = '—'; }

  // نلفّ الوحدة داخل $
  if (o.unit) o.unit = wrapMath(o.unit);

  // لو الوصف فاضي نعبيه من الرمز
  if (!o.desc || !String(o.desc).trim()){
    const key = String(o.symbol||'').replace(/\$/g,'').replace(/[\\{}]/g,'').trim();
    o.desc = SYMBOL_AR[key] || '—';
  }
  return o;
}
// نفس الاسم: لكن نضيف تعبئة desc إن كان فاضي ونرتّب الوحدة
function renderFormulasBox(list = []) {
  const box = document.createElement('div');
  box.className = 'box center';

  (list || []).forEach(f => {
    const d = document.createElement('div');
    d.className = 'math-block';

    const core = (f || '').replace(/\$+/g, ''); // إزالة أي $ داخلي
    const eq   = /^\s*\$\$/.test(f) ? f : `$$${core}$$`;

    d.innerHTML = MATH.htmlWithMath(eq);

    // ✨ لو هذه الصيغة هي المختارة، نضيف تمييز
    if (f === selectedFormula) {
      d.style.outline = "2px solid var(--accent)";
      d.style.borderRadius = "6px";
      d.style.padding = "4px";
    }

    box.appendChild(d);
  });

if (window.MathJax?.typesetPromise) MathJax.typesetPromise([box]);
  return box;
}

function renderFormulas(list = []) {
  const box = document.getElementById("expFormulas");
  box.innerHTML = "";

  (list || []).forEach(f => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pill";
    btn.innerHTML = f; // فيه $...$ أو $$...$$

    // ✨ تحديث جديد: سمات وصول
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-pressed", f === selectedFormula ? "true" : "false");

    // عند الضغط: نحفظ الاختيار ونبرز الزر
    btn.onclick = () => {
      selectedFormula = f;
      [...box.querySelectorAll(".pill")].forEach(el => {
        el.style.outline = "";
        el.setAttribute("aria-pressed", "false"); // الكل يصير غير مختار
      });
      btn.style.outline = "2px solid var(--accent)";
      btn.setAttribute("aria-pressed", "true"); // الزر الحالي يصير مختار
    };

    // ✨ ولو الزر هذا كان أصلاً مختار من قبل، نرجع نبرزه
    if (f === selectedFormula) {
      btn.style.outline = "2px solid var(--accent)";
      btn.setAttribute("aria-pressed", "true");
    }

    box.appendChild(btn);
  });

  // خلّي MathJax يرسم داخل الأزرار
if (window.MathJax?.typesetPromise) MathJax.typesetPromise([box]);
}

/* --------------------- عناصر واجهة عامة --------------------- */
const $ = (id) => document.getElementById(id);
function setBusy(t){ $('status').textContent=t||''; document.querySelectorAll('.btn').forEach(b=>b.disabled=!!t); }
function showErr(m){ const e=$('error'); e.style.display='block'; e.textContent=m||'حدث خطأ غير متوقع.'; }
function hideErr(){ const e=$('error'); e.style.display='none'; e.textContent=''; }
function hideAllSections(){
  ['secExplain','secEx1','secEx2','secPractice','secSolve']
    .forEach(id => { const n=$(id); if(n) n.style.display='none'; });
  hideErr();
}

/* ---------------------- قوالب العرض الموحدة ---------------------- */
function renderGivenUnknowns(givens=[], unknowns=[]){
  const tbl=document.createElement('table'); tbl.className='table center';
  tbl.innerHTML=`<thead><tr><th>الرمز</th><th>القيمة</th><th>الوحدة</th><th>الوصف</th></tr></thead>`;
  const tb=document.createElement('tbody');

  (givens||[]).map(normalizeRow).forEach(g=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td>${MATH.htmlWithMath(g.symbol||'')}</td>
      <td>${MATH.htmlWithMath(g.value||'')}</td>
      <td class="unit-cell">${MATH.htmlWithMath(wrapMath(g.unit||''))}</td>
      <td>${MATH.htmlWithMath(g.desc||'')}</td>`;
    tb.appendChild(tr);
  });

  if ((unknowns||[]).length){
    const sep=document.createElement('tr');
    const td=document.createElement('td'); td.colSpan=4; td.innerHTML='<span class="pill">المجاهيل</span>';
    sep.appendChild(td); tb.appendChild(sep);

    (unknowns||[]).map(normalizeRow).forEach(u=>{
      const r=document.createElement('tr');
      r.innerHTML=`
        <td>${MATH.htmlWithMath(u.symbol||'')}</td>
        <td>؟</td>
        <td class="unit-cell">—</td>
        <td>${MATH.htmlWithMath(u.desc||'')}</td>`;
      tb.appendChild(r);
    });
  }

  tbl.appendChild(tb);
if (window.MathJax?.typesetPromise) MathJax.typesetPromise([tbl]);
  return tbl;
}

/** عرض “اشرح لي” */
/** عرض “اشرح لي” */
function renderExplain(d, concept){
  // نظّفي كل صناديق القسم قبل التعبئة
  ['overview','expFormulas','symbols','steps'].forEach(id=>{
    const el = document.getElementById(id);
    if (el){ el.innerHTML=''; while(el.firstChild) el.removeChild(el.firstChild); }
  });

  document.getElementById('exTitle').textContent = d.title || concept || '';
  document.getElementById('chip2').textContent   = concept || '';

// ===== overview: احمي المعادلات الصحيحة وامسحي $ اليتيمة =====
{
  let ov = (d.overview || '—') + '';

  // نفك "\$" -> "$"
  ov = ov.replace(/\\\$/g, '$');

  // نحمي $$...$$ أولاً ثم $...$
  const keep = [];
  ov = ov.replace(/\$\$([\s\S]*?)\$\$/g, (_, x) => {
    keep.push({ t: 'B', x: `$$${x}$$` });
    return `§§K${keep.length - 1}§§`;
  });
  ov = ov.replace(/\$([^$]+)\$/g, (_, x) => {
    keep.push({ t: 'I', x: `$${x}$` });
    return `§§K${keep.length - 1}§§`;
  });

  // أي $ بقيت الآن يتيمة → احذفها
  ov = ov.replace(/\$/g, '');

  // نعيد ما حفظناه كما هو
  ov = ov.replace(/§§K(\d+)§§/g, (_m, i) => keep[i].x);

  document.getElementById('overview').innerHTML = MATH.htmlWithMath(ov);
} 

  // الصيغ (أزرار قابلة للاختيار)
  const expF = document.getElementById('expFormulas');
  expF.innerHTML = '';
  renderFormulas(d.formulas || []);

  // جدول الرموز والوحدات
  const tb = document.getElementById('symbols');
  (d.symbols||[]).map(normalizeRow).forEach(s=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${MATH.htmlWithMath(s.desc || '')}</td>
      <td>${MATH.htmlWithMath(s.symbol || '')}</td>
      <td class="unit-cell">${wrapMath(s.unit || '')}</td>`;
    tb.appendChild(tr);
  });

  // خطوات الاستخدام/الحل
  const st = document.getElementById('steps');
  (d.steps||[]).forEach(s=>{
    const li = document.createElement('li');
    li.innerHTML = MATH.htmlWithMath(s);
    st.appendChild(li);
  });

  // عرض القسم وإعادة typeset
  const sec = document.getElementById('secExplain');
  sec.style.display = 'block';
  if (window.MathJax?.typesetPromise) MathJax.typesetPromise([sec]);
}
/* ---------------------- عرض "مثال تطبيقي" / "مثال آخر" / "الحل الصحيح" ---------------------- */
/* ---------------------- عرض "مثال تطبيقي" / "مثال آخر" / "الحل الصحيح" ---------------------- */
/* ---------------------- عرض "مثال تطبيقي" / "مثال آخر" / "الحل الصحيح" ---------------------- */
function renderCase(id, d){
  const box = document.getElementById(id);
  if (!box) return;

  // نظّفي الحاوية أولًا
  box.innerHTML = '';

  // مساعد صغير لعناوين الأقسام
  const addSub = (txt) => {
    const h = document.createElement('h3');
    h.className = 'sub';
    h.style.textAlign = 'center';
    h.textContent = txt;
    box.appendChild(h);
  };

  // =========== 1) المسألة ===========
  if (d.scenario) {
    addSub('المسألة');
    const scen = document.createElement('div');
    scen.className = 'box center';
    scen.style.textAlign = 'right';          // نص المسألة من اليمين
    scen.style.lineHeight = '1.9';
    scen.innerHTML = MATH.htmlWithMath(d.scenario);
    box.appendChild(scen);
  }

  // =========== 2) المعطيات والمجاهيل ===========
  if ((d.givens && d.givens.length) || (d.unknowns && d.unknowns.length)) {
    addSub('المعطيات والمجاهيل');
    box.appendChild(renderGivenUnknowns(d.givens || [], d.unknowns || []));
  }

  // =========== 3) الصيغ/القانون ===========
  if (Array.isArray(d.formulas) && d.formulas.length) {
    addSub('القانون / الصيغ');
    box.appendChild(renderFormulasBox(d.formulas));
  }

  // =========== 4) خطوات الحل ===========
  if (Array.isArray(d.steps) && d.steps.length) {
    addSub('خطوات الحل');
    const stepsWrap = document.createElement('div');
    stepsWrap.className = 'box center';
    const ol = document.createElement('ol');
    ol.style.textAlign = 'right';           // خطوات من اليمين
    ol.style.lineHeight = '1.9';
    d.steps.forEach(s => {
      const li = document.createElement('li');
      li.innerHTML = MATH.htmlWithMath(s);
      ol.appendChild(li);
    });
    stepsWrap.appendChild(ol);
    box.appendChild(stepsWrap);
  }

  // =========== 5) النتيجة النهائية ===========
  if (d.result) {
    addSub('النتيجة النهائية');
    const res = document.createElement('div');
    res.className = 'box center';
    // نخلي المعادلة في سطر كبير وسط
    const eq = document.createElement('div');
    eq.className = 'math-block';
    eq.innerHTML = MATH.htmlWithMath(d.result);
    res.appendChild(eq);
    box.appendChild(res);
  }

  // Typeset
  if (window.MathJax?.typesetPromise) MathJax.typesetPromise([box]);
}
/* ---------------------- استدعاء الدالة السحابية ---------------------- */
let LAST_PRACTICE_QUESTION = '';
let LAST_EX1_SCENARIO = '';
async function call(action, extra){
  const concept = ($('concept').value || '').trim();
  if (!concept){ showErr('أدخلي اسم القانون/المفهوم أولًا.'); return null; }

  // نص الحالة في الزرار
  setBusy({
    explain:'جارٍ توليد الشرح…',
    ex1:'جارٍ إنشاء المثال…',
    ex2:'جارٍ إنشاء المثال الآخر…',
    practice:'جارٍ إنشاء سؤال التدريب…',
    solve:'جارٍ الحل…'
  }[action] || 'جارٍ العمل…');

  try {
    // نحاول حتى 3 مرات لو الخطأ INCOMPLETE_EXAMPLE (أو شبيه)
    const maxTries = (/^(ex1|ex2|solve)$/.test(action)) ? 3 : 1;

    for (let tryNo = 1; tryNo <= maxTries; tryNo++) {
      const res = await fetch('/.netlify/functions/anees', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          action: {explain:'explain',ex1:'example',ex2:'example2',practice:'practice',solve:'solve'}[action] || action,
          concept,
          question: extra?.question || null,
          preferred_formula: selectedFormula || ""
        })
      });

      const txt = await res.text();
      let json = null;
      try { json = JSON.parse(txt); } catch(_) {}

      // نجاح صريح
      if (res.ok && json && json.ok !== false) {
        return json.data || json;
      }

      // استخرج الرسالة (سواء من body أو النص)
      const errMsg = (json && (json.error || json?.data?.error)) || txt || ('HTTP '+res.status);
      const isIncomplete = /INCOMPLETE_EXAMPLE/i.test(errMsg);

      // لو مثال ناقص وجربنا أقل من الحد، نعيد المحاولة
      if (isIncomplete && tryNo < maxTries) {
        await new Promise(r => setTimeout(r, 450));
        continue;
      }

      // غير ذلك: ارمي الخطأ
      throw new Error(errMsg);
    }

    // لو خلصت الحلقة بدون return (نادرًا)
    throw new Error('تعذّر إنشاء مثال مكتمل.');
  } catch (err) {
    showErr(err.message || 'حدث خطأ غير متوقع.');
    return null;
  } finally {
    setBusy('');
  }
}

/* ---------------------- ربط الأزرار وتشغيل العرض ---------------------- */
(function wire(){
  $('btnExplain').addEventListener('click', async ()=>{
    hideAllSections();
    const d = await call('explain'); 
    if (!d) return;
    renderExplain(d, $('concept').value);
  });

  $('concept').addEventListener('input', ()=> { selectedFormula = ""; });

  $('btnEx1').addEventListener('click', async ()=>{
    hideAllSections();
    const d = await call('ex1'); 
    if (!d) return;
    renderCase('ex1', d);
    $('secEx1').style.display = 'block';
    // نخزن سيناريو المثال الأول لتفادي تكراره في "اختبر فهمي"
    LAST_EX1_SCENARIO = (d.scenario || '').trim();
  });

  $('btnEx2').addEventListener('click', async ()=>{
    hideAllSections();
    const d = await call('ex2'); 
    if (!d) return;
    renderCase('ex2', d);
    $('secEx2').style.display = 'block';
  });

  $('btnPractice').addEventListener('click', async ()=>{
    hideAllSections();

    let tries = 0, d = null;
    do {
      d = await call('practice');
      if (!d) return;
      tries++;
    } while (
      tries < 3 &&
      (
        (d.question || '').trim() === (LAST_PRACTICE_QUESTION || '').trim() ||
        (d.question || '').trim() === (LAST_EX1_SCENARIO || '').trim()
      )
    );

    LAST_PRACTICE_QUESTION = d.question || '';
    $('practice').innerHTML = MATH.htmlWithMath(LAST_PRACTICE_QUESTION || '—');
    $('secPractice').style.display = 'block';
if (window.MathJax?.typesetPromise) MathJax.typesetPromise([$('practice')]);
  });

  $('btnSolve').addEventListener('click', async ()=>{
    hideAllSections();
    if (!LAST_PRACTICE_QUESTION){
      showErr('اعرضي أولاً سؤال "اختبر فهمي" ثم اضغطي "الحل الصحيح".');
      return;
    }
    const d = await call('solve', { question: LAST_PRACTICE_QUESTION });
    if (!d) return;
    renderCase('solve', d);
    $('secSolve').style.display = 'block';
  });
})();
// ====== Theme toggle (dark / light) ======
(function(){
  const btn = document.getElementById('themeBtn');
  if (!btn) return;

  // استرجاع من التخزين (لو كان المستخدم اختار قبل كذا)
  if (localStorage.getItem('theme') === 'dark') {
    document.documentElement.classList.add('dark');
    btn.textContent = 'الوضع الفاتح';
  }

  btn.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    btn.textContent = isDark ? 'الوضع الفاتح' : 'الوضع الداكن';
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });
})();
