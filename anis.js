/* ========================================================================
   Frontend JS — العرض الموحّد لكل الصفحات + حماية تنسيقات LaTeX
   - MATH.htmlWithMath: يمرر LaTeX لـ MathJax بأمان (كتل $$...$$ وسطرية $...$).
   - normalizeRow: يكتشف إن كانت الوحدة انزلقت في "الوصف" ويعيدها لمكانها.
   - renderExplain / renderCase: قوالب متطابقة للجداول والقوانين والخطوات.
   - call(): يتصل بـ Netlify Function ويعرض رسائل مفيدة عند الخطأ.
   ======================================================================== */

/* ---------------------- Math helpers ---------------------- */
const MATH = (() => {
  // تنظيف سريع لأي نص
  const clean = s => (s ?? "").toString().replace(/\r/g, "\n").trim();

  // نضيف backslash للدوال الشائعة لو نقصت (حذرًا من تلوّث رموز عربية)
  const fixLatex = (s) => clean(s).replace(/(^|[^\\])\b(frac|sqrt|mathrm|cdot)\b/g, '$1\\$2');

  // نحافظ على $$...$$ (كتل) و$...$ (سطرية) ونحوّلها لعناصر HTML ليستقبلها MathJax
  function htmlWithMath(input) {
    let s = fixLatex(input || "");
    const blocks = [], inlines = [];

    s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => {
      blocks.push('$$' + inner + '$$');
      return '§§B' + (blocks.length - 1) + '§§';
    });
    s = s.replace(/\$([^$]+)\$/g,   (_, inner) => {
      inlines.push('$' + inner + '$');
      return '§§I' + (inlines.length - 1) + '§§';
    });

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

/** يعالج صفًا واحدًا:
 * - إن كانت الوحدة هربت للـ desc نعيدها لـ unit.
 * - نلفّ الوحدة بالدولار لعرض رياضي أكيد.
 */
function normalizeRow(obj){
  const o = { ...obj };
  if (!o.unit && probablyUnit(o.desc)) {
    o.unit = o.desc; o.desc = '—';
  }
  if (o.unit && !hasMathDelim(o.unit)) {
    o.unit = wrapMath(o.unit);
  }
  return o;
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
  if (window.MathJax?.typesetPromise) MathJax.typesetPromise();
  return tbl;
}

function renderFormulasBox(list=[]){
  const box=document.createElement('div'); box.className='box center';
  (list||[]).forEach(f=>{
    const d=document.createElement('div'); d.className='math-block';
    const eq=/^\$\$/.test(f)?f:`$$${(f||'').replace(/^\$|\$$/g,'')}$$`;
    d.innerHTML=MATH.htmlWithMath(eq); box.appendChild(d);
  });
  if (window.MathJax?.typesetPromise) MathJax.typesetPromise();
  return box;
}

/** عرض “اشرح لي” */
function renderExplain(d, concept){
  $('exTitle').textContent = d.title || concept || '';
  $('chip2').textContent   = concept || '';
  $('overview').innerHTML  = MATH.htmlWithMath(d.overview||'—');

  // الصيغ أعلى الجدول وبالوسط
  const expF=$('expFormulas'); expF.innerHTML=''; expF.appendChild(renderFormulasBox(d.formulas||[]));

  // جدول الرموز والوحدات بنفس منطق باقي الصفحات
  const tb=$('symbols'); tb.innerHTML='';
  (d.symbols||[]).map(normalizeRow).forEach(s=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td>${MATH.htmlWithMath(s.desc||'')}</td>
      <td>${MATH.htmlWithMath(s.symbol||'')}</td>
      <td class="unit-cell">${MATH.htmlWithMath(wrapMath(s.unit||''))}</td>`;
    tb.appendChild(tr);
  });

  // خطوات الاستخدام/الحل
  const st=$('steps'); st.innerHTML='';
  (d.steps||[]).forEach(s=>{ const li=document.createElement('li'); li.innerHTML=MATH.htmlWithMath(s); st.appendChild(li); });

  $('secExplain').style.display='block';
  if (window.MathJax?.typesetPromise) MathJax.typesetPromise();
}

/** عرض مثال/حل بنفس القالب */
function renderCase(containerId, data){
  const root = $(containerId); root.innerHTML='';
  const frag = document.createDocumentFragment();

  // المسألة (سيناريو نصي واضح)
  const s1=document.createElement('div');
  s1.innerHTML = `<div class="sub">المسألة</div><div class="box">${MATH.htmlWithMath(data.scenario || data.question || '—')}</div>`;
  frag.appendChild(s1);

  // المعطيات والمجاهيل (جدول موحد)
  const s2=document.createElement('div'); s2.className='sub'; s2.textContent='المعطيات والمجاهيل';
  const b2=document.createElement('div'); b2.className='box';
  b2.appendChild(renderGivenUnknowns(data.givens||[], data.unknowns||[]));
  frag.appendChild(s2); frag.appendChild(b2);

  // القوانين المستخدمة (كل قانون بسطر)
  const s3=document.createElement('div'); s3.className='sub'; s3.textContent='القانون/القوانين المستخدمة';
  frag.appendChild(s3); frag.appendChild(renderFormulasBox(data.formulas||(data.formula?[data.formula]:[])));

  // الحل والخطوات
  const s4=document.createElement('div'); s4.className='sub'; s4.textContent='الحل والخطوات';
  const b4=document.createElement('div'); b4.className='box';
  const ol=document.createElement('ol');
  (data.steps||[]).forEach(step=>{ const li=document.createElement('li'); li.innerHTML=MATH.htmlWithMath(step); ol.appendChild(li); });
  if((data.steps||[]).length) b4.appendChild(ol);

  // النتيجة النهائية (كبيرة وواضحة)
  if (data.result){
    const hr=document.createElement('div'); hr.style.height='1px'; hr.style.background='color-mix(in oklab, var(--ring) 70%, transparent 30%)'; hr.style.margin='8px 0';
    b4.appendChild(hr);
    const big=document.createElement('div'); big.className='math-block';
    const eq=/^\$\$/.test(data.result)?data.result:`$$${data.result.replace(/^\$|\$$/g,'')}$$`;
    big.innerHTML=MATH.htmlWithMath(eq); b4.appendChild(big);
  }

  frag.appendChild(s4); frag.appendChild(b4);
  root.appendChild(frag);
  if (window.MathJax?.typesetPromise) MathJax.typesetPromise();
}

/* ---------------------- استدعاء الدالة السحابية ---------------------- */
let LAST_PRACTICE_QUESTION = '';

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
        question: extra?.question || null
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
  $('btnExplain') .addEventListener('click', async ()=>{
    hideAllSections();
    const d = await call('explain'); if(!d) return;
    renderExplain(d, $('concept').value);
  });

  $('btnEx1')     .addEventListener('click', async ()=>{
    hideAllSections();
    const d = await call('ex1'); if(!d) return;
    renderCase('ex1', d); $('secEx1').style.display='block';
  });

  $('btnEx2')     .addEventListener('click', async ()=>{
    hideAllSections();
    const d = await call('ex2'); if(!d) return;
    renderCase('ex2', d); $('secEx2').style.display='block';
  });

  $('btnPractice').addEventListener('click', async ()=>{
    hideAllSections();
    const d = await call('practice'); if(!d) return;
    LAST_PRACTICE_QUESTION = d.question || '';
    $('practice').innerHTML = MATH.htmlWithMath(LAST_PRACTICE_QUESTION || '—');
    $('secPractice').style.display='block';
    if (window.MathJax?.typesetPromise) MathJax.typesetPromise();
  });

  $('btnSolve')   .addEventListener('click', async ()=>{
    hideAllSections();
    if(!LAST_PRACTICE_QUESTION){
      showErr('اعرضي أولاً سؤال "اختبر فهمي" ثم اضغطي "الحل الصحيح".');
      return;
    }
    const d = await call('solve', {question: LAST_PRACTICE_QUESTION});
    if(!d) return;
    renderCase('solve', d); $('secSolve').style.display='block';
  });
})();
