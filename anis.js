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

  // نحافظ على $$...$$ (كتل) و$...$ (سطرية) ونحوّلها لعناصر HTML ليستقبلها MathJax
  function htmlWithMath(input) {
  let s = fixLatex(input || "");
  const blocks = [], inlines = [];
     
// 1) نك الهروب \$ -> $
s = s.replace(/\\\$/g, '$');

// 2) كتلة رياضية قبل الدولارات \[ ... \]
s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => {
  blocks.push('$$' + inner + '$$');
  return '§§B' + (blocks.length - 1) + '§§';
});

// 3) كسطرية قبل الدولارات \( ... \)
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

  // 6) إعادة الحقن ليرسمها MathJax
  s = s
    .replace(/§§B(\d+)§§/g, (_, i) => `<div class="math-block">${blocks[i]}</div>`)
    .replace(/§§I(\d+)§§/g, (_, i) => `<span class="math-inline">${inlines[i]}</span>`);

  // 7) لفّ أي \mathrm{...} بقيت عارية
  s = s.replace(/(\\mathrm\{[^}]+\})/g, '<span class="math-inline">$$$1$$</span>');

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
function renderExplain(d, concept){
  // نظّفي كل صناديق القسم قبل التعبئة
  ['overview','expFormulas','symbols','steps'].forEach(id=>{
    const el = document.getElementById(id);
    if (el){ el.innerHTML=''; while(el.firstChild) el.removeChild(el.firstChild); }
  });

  document.getElementById('exTitle').textContent = d.title || concept || '';
  document.getElementById('chip2').textContent   = concept || '';

  // ----- تعريف overview (نزيل $ اليتيمة + نحوّل السطرية/الكتلية لصيغ MathJax القياسية) -----
  {
    let ov = (d.overview || '—') + '';

    // نفك "\$" -> "$"
    ov = ov.replace(/\\\$/g, '$');

    // نحمي المعادلات مؤقتًا
    const blocks = [], inlines = [];
    ov = ov.replace(/\\\[([\s\S]*?)\\\]/g, (_, x) => { blocks.push(x);  return '§§B'+(blocks.length-1)+'§§'; });
    ov = ov.replace(/\\\(([\s\S]*?)\\\)/g, (_, x) => { inlines.push(x); return '§§I'+(inlines.length-1)+'§§'; });
    ov = ov.replace(/\$\$([\s\S]*?)\$\$/g,       (_, x) => { blocks.push(x);  return '§§B'+(blocks.length-1)+'§§'; });
    ov = ov.replace(/\$([^$]+)\$/g,              (_, x) => { inlines.push(x); return '§§I'+(inlines.length-1)+'§§'; });

    // أي $ بقيت الآن يتيمة → احذفها
    ov = ov.replace(/\$/g, '');

    // استرجاع: الكتل \[...\] والسطرية \(...\)
    ov = ov
      .replace(/§§B(\d+)§§/g, (_m, i) => `\$begin:math:display$${blocks[i]}\\$end:math:display$`)
      .replace(/§§I(\d+)§§/g, (_m, i) => `\$begin:math:text$${inlines[i]}\\$end:math:text$`);

    // مرّريه ليترسم
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
/* ---------------------- استدعاء الدالة السحابية ---------------------- */
let LAST_PRACTICE_QUESTION = '';
let LAST_EX1_SCENARIO = '';
async function call(action, extra){
  const concept = ($('concept').value || '').trim();
  if (!concept){ showErr('أدخلي اسم القانون/المفهوم أولًا.'); return null; }

  setBusy({
    explain:'جارٍ توليد الشرح…',
    ex1:'جارٍ إنشاء المثال…',
    ex2:'جارٍ إنشاء المثال الآخر…',
    practice:'جارٍ إنشاء سؤال التدريب…',
    solve:'جارٍ الحل…'
  }[action] || 'جارٍ العمل…');

  try{
    const res = await fetch('/.netlify/functions/anees', {
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body: JSON.stringify({
    action: {explain:'explain',ex1:'example',ex2:'example2',practice:'practice',solve:'solve'}[action] || action,
    concept,
    question: extra?.question || null,
    // 👇 أرسلي الصيغة المختارة (إن وُجدت)
    preferred_formula: selectedFormula || ""
  })
});

    const txt = await res.text();
    let json = null;
    try{ json = JSON.parse(txt); }catch(_){ /* نحاول دائمًا */ }

    if(!res.ok){
      const msg = (json && json.error) ? json.error : (txt.slice(0,300) || ('HTTP '+res.status));
      throw new Error(msg);
    }

    const payload = json?.data || json;
    if (payload?.error){ throw new Error(payload.error); }
    return payload;

  }catch(err){
    showErr(err.message || 'حدث خطأ غير متوقع.');
    return null;
  }finally{
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
