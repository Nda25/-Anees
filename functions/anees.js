/** ============ واجهة الويب ============ **/
function doGet() {
  return HtmlService
    .createHtmlOutputFromFile('index')
    .setTitle('المساعد الذكي')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** ===== أدوات مساعدة عامة ===== */
function _norm(x){ return (x||'').toString().trim(); }

/** اقتطاع وتنظيف كتلة JSON من نص حر (بدون العبث بلايتكس) */
function _extractJsonBlock_(text){
  let t = (text||'').trim();

  // إزالة أسوار الأكواد إن وُجدت
  t = t.replace(/^```json/gi,'```')
       .replace(/^```/,'')
       .replace(/```$/,'')
       .trim();

  // حاول إيجاد أوسع { ... }
  let a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    t = t.slice(a, b+1);
  } else {
    const m = t.match(/{[\s\S]*}/);
    if (m) t = m[0]; else return '';
  }

  // توحيد علامات الاقتباس الذكية
  t = t.replace(/[“”]/g,'"').replace(/[‘’]/g,"'");

  // حذف الفواصل المتدلّية
  t = t.replace(/,\s*([}\]])/g,'$1');

  // لا نعبث بعلامات " داخل النص (حتى لا نفسد LaTeX)
  return t;
}

/** تحليل JSON صارم */
function _parseJsonStrict_(text){
  const t = _extractJsonBlock_(text);
  if (!t) throw new Error('Could not extract a valid JSON block.');
  return JSON.parse(t);
}

/** تحقّق بسيط من مطابقة الشكل المطلوب */
function _validateShape(action, obj){
  if (!obj || typeof obj !== 'object') return 'الاستجابة ليست كائن JSON.';
  const has = k => Object.prototype.hasOwnProperty.call(obj,k);

  if (action === 'explain'){
    if (!(has('title') && has('overview') && has('symbols') && has('formulas') && has('steps')))
      return 'مفاتيح explain ناقصة.';
    if (!Array.isArray(obj.symbols) || !Array.isArray(obj.formulas) || !Array.isArray(obj.steps))
      return 'قوائم explain يجب أن تكون مصفوفات.';
    return null;
  }
  if (action === 'example' || action === 'example2'){
    if (!(has('title') && has('scenario') && has('given') && has('required') && has('steps') && has('result')))
      return 'مفاتيح المثال ناقصة.';
    if (!Array.isArray(obj.given) || !Array.isArray(obj.steps))
      return 'قوائم المثال يجب أن تكون مصفوفات.';
    return null;
  }
  if (action === 'practice'){ if (!has('question')) return 'سؤال التدريب مفقود.'; return null; }
  if (action === 'solve'){ if (!has('solution')) return 'حلّ المسألة مفقود.'; return null; }
  return 'إجراء غير معروف.';
}

/** ===== استدعاء Gemini (REST) ===== */
function _geminiFetch_(prompt, schemaObj){
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('أضيفي مفتاح GEMINI_API_KEY في Script properties.');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key='+key;

  const body = {
    contents: [{ role:'user', parts:[{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 900,
      response_mime_type: 'application/json',
      response_schema: schemaObj || undefined
    }
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const status = res.getResponseCode();
  const txt = res.getContentText() || '';
  let j = {}; try { j = JSON.parse(txt); } catch(e){}

  const apiMsg = (j.error && (j.error.message || j.error.status)) || '';
  if (status >= 400 || !j.candidates) {
    if (/quota|exceed|RESOURCE_EXHAUSTED/i.test(apiMsg))
      throw new Error('نفدت الحصة (quota) لمفتاح Gemini. فعّلي الفوترة أو استخدمي مفتاحًا آخر.');
    throw new Error('تعذّر الاتصال بـ Gemini: ' + (apiMsg || ('HTTP '+status)));
  }

  const raw = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!raw) throw new Error('لم تصل استجابة صالحة من النموذج.');
  return raw;
}

/** ===== استدعاء OpenAI (Responses API) ===== */
function _openaiFetch_(prompt, schemaObj){
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('OPENAI_API_KEY');
  if (!key) throw new Error('أضيفي مفتاح OPENAI_API_KEY في Script properties.');

  const model = props.getProperty('OPENAI_MODEL') || 'gpt-4o-mini';
  const url = 'https://api.openai.com/v1/responses';

  const body = {
    model: model,
    input: prompt,
    response_format: schemaObj ? {
      type: 'json_schema',
      json_schema: { name: 'bot_schema', schema: schemaObj, strict: true }
    } : { type: 'json_object' }
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const status = res.getResponseCode();
  const txt = res.getContentText() || '';
  let j = {}; try { j = JSON.parse(txt); } catch(e){}

  if (status >= 400) {
    const apiMsg = (j.error && (j.error.message || j.error.type)) || txt;
    throw new Error('تعذّر الاتصال بـ OpenAI: ' + apiMsg);
  }

  if (typeof j.output_text === 'string' && j.output_text.trim()) return j.output_text;

  try{
    const maybe = j.output && j.output[0] && j.output[0].content && j.output[0].content[0] && j.output[0].content[0].text;
    if (maybe && typeof maybe === 'string') return maybe;
  }catch(e){}

  try{
    const cc = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (cc && typeof cc === 'string') return cc;
  }catch(e){}

  throw new Error('استجابة OpenAI غير متوقَّعة؛ تعذّر استخراج النص.');
}

/** ===== إعدادات المزودين و الفيل-أوفر ===== */
function _getProviders(){
  const props = PropertiesService.getScriptProperties();
  const primary = (props.getProperty('PRIMARY_PROVIDER') || 'OPENAI').toUpperCase();
  const fallback = (props.getProperty('FALLBACK_PROVIDER') || 'GEMINI').toUpperCase();
  return { primary, fallback };
}
function _hasKey(provider){
  const props = PropertiesService.getScriptProperties();
  if (provider === 'OPENAI') return !!props.getProperty('OPENAI_API_KEY');
  if (provider === 'GEMINI') return !!props.getProperty('GEMINI_API_KEY');
  return false;
}
function _callProvider(provider, prompt, schema){
  if (provider === 'OPENAI') return _openaiFetch_(prompt, schema);
  if (provider === 'GEMINI') return _geminiFetch_(prompt, schema);
  throw new Error('مزود غير مدعوم: '+provider);
}
function _repairJsonWith_(provider, brokenText, schemaObj){
  const fixPrompt =
`لديك نص يُفترض أنه JSON لكنه قد يحوي أخطاء اقتباس/صياغة.
أعِد «فقط» JSON صالح 100٪ يطابق المخطط المُرسل، بلا أي شرح خارج الكائن.
النص:
<<<
${brokenText}
>>>`;
  return _callProvider(provider, fixPrompt, schemaObj);
}
function _tryOnce(provider, action, prompt, schema){
  const raw = _callProvider(provider, prompt, schema);
  let obj;
  try { obj = _parseJsonStrict_(raw); }
  catch(e){
    const repaired = _repairJsonWith_(provider, raw, schema);
    obj = _parseJsonStrict_(repaired);
  }
  const bad = _validateShape(action, obj);
  if (bad) throw new Error(bad);
  return obj;
}

/** ===== نقطة خدمة الأزرار (Failover صامت) ===== */
function doAction(action, subject, concept, extra) {
  subject = _norm(subject || 'الفيزياء');
  concept = _norm(concept);
  if (!concept) return { ok:false, error:'أدخل اسم القانون/المفهوم أولًا.' };

  const schemaExplain = {
    type:'object',
    required:['title','overview','symbols','formulas','steps'],
    properties:{
      title:{type:'string'},
      overview:{type:'string'},
      symbols:{type:'array', items:{type:'string'}},
      formulas:{type:'array', items:{type:'string'}},
      steps:{type:'array', items:{type:'string'}}
    }
  };
  const schemaExample = {
    type:'object',
    required:['title','scenario','given','required','steps','result'],
    properties:{
      title:{type:'string'},
      scenario:{type:'string'},
      given:{type:'array', items:{type:'string'}},
      required:{type:'string'},
      steps:{type:'array', items:{type:'string'}},
      result:{type:'string'},
      formula:{type:'string'}
    }
  };
  const schemaPractice = { type:'object', required:['question'], properties:{ question:{type:'string'} } };
  const schemaSolve = { type:'object', required:['solution'], properties:{ solution:{type:'string'} } };

  const header =
`انسَ كل المحادثات السابقة.
أنت خبير في ${subject}.
اكتب بالعربية الفصحى فقط، وأعِد كائن JSON خالصًا بلا أي نص خارجي.
ممنوع إدراج أي كلمات إنجليزية في الشرح العربي؛ استخدم الإنجليزية فقط داخل LaTeX للصيغ والوحدات والرموز.
اكتب كل المعادلات والرموز والقوانين بالإنجليزية (متغيرات لاتينية، وحدات إنجليزية داخل \\mathrm{}).
استخدم $...$ للمعادلات القصيرة و $$...$$ للكتلية.
اكتب الوحدات داخل \\mathrm{}: \\mathrm{m}, \\mathrm{s}, \\mathrm{kg}, \\mathrm{mol}, \\mathrm{g/mol}, \\mathrm{Pa}, \\mathrm{J}, \\mathrm{W}, \\mathrm{N}, \\mathrm{V}, \\mathrm{A}, \\mathrm{Hz}, \\mathrm{m/s}, \\mathrm{m/s^2}, \\mathrm{atm}, \\mathrm{bar}, \\mathrm{L}, \\mathrm{mol/L}.
عند كتابة عدد مع وحدته، استخدم LaTeX بهذا الشكل: \`$9.8\\,\\mathrm{m/s^2}$\`.
التزم باستخدام علامات الاقتباس المزدوجة فقط (""). استخدم علامة \\" إذا كان النص يحتوي على علامة اقتباس داخلية.
المادة: ${subject} — القانون/المفهوم: «${concept}».`;

  let prompt = '', schema = null;
  switch(action){
    case 'explain':
      prompt = header + `
أعد JSON بالمفاتيح التالية:
{
"title":"عنوان عربي واضح",
"overview":"تعريف موجز وصحيح (عربي خالص بلا كلمات إنجليزية خارج LaTeX)",
"symbols":["F = force (\\$F$)","m = mass (\\$m$)","a = acceleration (\\$a$)"],
"formulas":["$$ F = ma $$"],
"steps":["Step 1","Step 2","Step 3"]
}`; schema = schemaExplain; break;

    case 'example':
      prompt = header + `
أنشئ مثالًا عدديًا متوسط الصعوبة مرتبطًا مباشرة بالقانون، وأعد JSON:
{
"title":"Worked example on ${concept}",
"scenario":"Brief problem statement in Arabic (no English words outside LaTeX).",
"given":["quantity = value \\$\\mathrm{unit}$","..."],
"required":"What is required (Arabic).",
"steps":["Each step with formulas inside \\$...$ or $$...$$ only","..."],
"result":"Final numeric result with unit, e.g. \\$12.3\\\\,\\\\mathrm{m/s}$",
"formula":"$$ optional\\ concise\\ final\\ formula $$"
}`; schema = schemaExample; break;

    case 'example2':
      prompt = header + `
أنشئ مثالًا آخر مختلف المعطيات وبنفس البنية (JSON كما في المثال التطبيقي).`;
      schema = schemaExample; break;

    case 'practice':
      prompt = header + `
اكتب «سؤال تدريب» واحدًا واضحًا يعتمد فقط على هذا القانون.
الشروط:
- لا تكتب كلمة "string" ولا "placeholder".
- اجعل السؤال جملة كاملة (≥ 20 حرفًا).
- تضمين عدد واحد + وحدة صحيحة بصيغة LaTeX مثل: $5\\,\\mathrm{m}$.
- لا تضع أي معادلات أو خطوات أو خيارات؛ نص السؤال فقط.
أعد JSON فقط بهذا الشكل: { "question": "النص هنا" }`;
      schema = schemaPractice; break;

    case 'solve':
      const q = (extra && extra.question) ? extra.question : `اكتب مسألة قصيرة عن «${concept}» ثم حلّها`;
      prompt = header + `
حلّ المسألة التالية بخطوات مرتّبة؛ استخدم LaTeX داخل \\$...$ أو $$...$$ عند الحاجة.
السؤال: ${q}
أعد JSON:
{ "solution":"حل عربي مرتب مع الصيغ بالإنجليزية داخل LaTeX" }`;
      schema = schemaSolve; break;

    default:
      return { ok:false, error:'إجراء غير معروف.' };
  }

  const { primary, fallback } = _getProviders();

  try {
    if (_hasKey(primary)) {
      const obj = _tryOnce(primary, action, prompt, schema);
      return { ok:true, data: obj };
    }
    if (_hasKey(fallback)) {
      const obj2 = _tryOnce(fallback, action, prompt, schema);
      return { ok:true, data: obj2 };
    }
    throw new Error('لا يوجد مفاتيح API صالحة: تأكدي من OPENAI_API_KEY أو GEMINI_API_KEY في Script properties.');
  } catch(e1) {
    try {
      if (_hasKey(fallback)) {
        const obj2 = _tryOnce(fallback, action, prompt, schema);
        return { ok:true, data: obj2 };
      }
      throw e1;
    } catch(e2){
      return { ok:false, error: (e2 && e2.message) ? e2.message : (e2 || 'خطأ غير متوقع.') };
    }
  }
}
