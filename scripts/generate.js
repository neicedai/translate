#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

const PUNCTUATION_RE = /[，。！？、；：、“”‘’（）《》〈〉【】『』]/;

async function main(){
  const options = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, '..');
  const bookDir = path.join(rootDir, 'book');
  const outDir = path.resolve(rootDir, options.outDir || 'dist');
  await fs.mkdir(outDir, { recursive: true });

  const manifestPath = path.join(bookDir, 'manifest.json');
  const manifest = await readJson(manifestPath);
  const targets = filterManifest(manifest, options.files);
  if(!targets.length){
    throw new Error('未找到需要处理的篇目。');
  }

  const apiConfig = resolveApiConfig(options);
  if(!options.skipApi && (!apiConfig.url || !apiConfig.key || !apiConfig.model)){
    throw new Error('请通过环境变量或参数提供 DeepSeek API 的 url、key 与 model。');
  }

  const generated = [];
  for(const meta of targets){
    const filePath = path.join(bookDir, meta.file);
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = parseContent(raw);
    if(!parsed.originalLines.length){
      console.warn(`[WARN] ${meta.file} 未包含可注释的原文，跳过。`);
      continue;
    }
    let translation;
    if(options.skipApi){
      translation = createEmptyTranslation(parsed);
    }else{
      const payload = await translateWithDeepseek(apiConfig, meta, parsed);
      translation = normaliseTranslation(parsed, payload);
    }
    const html = buildPageHtml(meta, parsed, translation);
    const outName = meta.file.replace(/\.txt$/i, '.html');
    const outPath = path.join(outDir, outName);
    await fs.writeFile(outPath, html, 'utf8');
    generated.push({
      title: translation.title || meta.title || outName,
      outputName: outName
    });
    console.log(`[INFO] 已生成 ${outName}`);
  }

  if(!generated.length){
    console.warn('[WARN] 没有生成任何页面。');
    return;
  }

  const navHtml = buildNavigationPage(generated);
  const navPath = path.join(outDir, 'liaozhai-book-index.html');
  await fs.writeFile(navPath, navHtml, 'utf8');
  console.log(`[INFO] 导航页已生成：${path.relative(rootDir, navPath)}`);
}

function parseArgs(args){
  const options = { files: null, skipApi: false };
  for(let i = 0; i < args.length; i++){
    const token = args[i];
    if(token === '--out' || token === '--out-dir'){
      options.outDir = args[++i];
    }else if(token === '--files'){
      options.files = args[++i];
    }else if(token === '--api-url'){
      options.apiUrl = args[++i];
    }else if(token === '--api-key'){
      options.apiKey = args[++i];
    }else if(token === '--api-model'){
      options.apiModel = args[++i];
    }else if(token === '--skip-api'){
      options.skipApi = true;
    }else{
      console.warn(`[WARN] 未识别的参数：${token}`);
    }
  }
  return options;
}

function filterManifest(manifest, filesOption){
  if(!filesOption){
    return manifest;
  }
  const wanted = new Set(filesOption.split(',').map(s => s.trim()).filter(Boolean));
  return manifest.filter(item => wanted.has(item.file) || (item.title && wanted.has(item.title)));
}

async function readJson(file){
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

function resolveApiConfig(options){
  return {
    url: options.apiUrl || process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
    key: options.apiKey || process.env.DEEPSEEK_API_KEY || '',
    model: options.apiModel || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  };
}

function parseContent(text){
  const whiteMark = '【白话文翻译】';
  const commentMark = '【点评】';
  const idxWhite = text.indexOf(whiteMark);
  const idxComment = text.indexOf(commentMark);
  let original = text;
  let vernacular = '';
  let comment = '';
  if(idxWhite !== -1){
    original = text.slice(0, idxWhite);
    if(idxComment !== -1){
      vernacular = text.slice(idxWhite + whiteMark.length, idxComment);
      comment = text.slice(idxComment + commentMark.length);
    }else{
      vernacular = text.slice(idxWhite + whiteMark.length);
    }
  }
  const originalLines = original.split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
  return {
    originalText: original.trim(),
    originalLines,
    vernacular: vernacular.trim(),
    comment: comment.trim()
  };
}

async function translateWithDeepseek(cfg, meta, content){
  if(typeof fetch !== 'function'){
    throw new Error('当前 Node.js 环境不支持 fetch，请升级至 v18 或以上。');
  }
  const req = {
    title: meta.title || meta.file,
    lines: content.originalLines.map((text, index) => ({
      index,
      text,
      charList: Array.from(text).map((ch, i) => ({ i, ch }))
    }))
  };
  const systemPrompt = [
    '你是严谨的文言注释助手，请对提供的每一行文言文生成逐字及重点词组释义。',
    '要求：',
    '1. 仅使用给定的 charList 中的字符与索引，禁止新增或改写原文；',
    '2. 若能判断词组释义，请在 phrases 中记录起止索引，并给出简明释义；',
    '3. 对缺乏明确释义的字词可留空；',
    '4. 不要输出整段白话文翻译；',
    '5. 严格只返回 JSON，格式：{"title":"注释标题(可选)","summary":"可选概述","lines":[{"index":行号,"chars":[{"i":索引,"p":"拼音(可选)","g":"释义(可选)"}],"phrases":[{"s":起,"e":止,"p":"拼音(可选)","g":"释义(可选)"}]}]}'
  ].join('\n');
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(req) }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  };
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.key
    },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const txt = await res.text();
    throw new Error(`DeepSeek 请求失败：HTTP ${res.status} ${txt.slice(0, 180)}`);
  }
  const data = await res.json();
  let payload = data;
  if(data?.choices?.[0]?.message?.content){
    try{
      payload = JSON.parse(data.choices[0].message.content);
    }catch(err){
      console.warn('[WARN] 模型返回内容解析失败，将使用原始响应。', err);
    }
  }
  return payload;
}

function createEmptyTranslation(content){
  return {
    title: '',
    summary: '',
    lines: content.originalLines.map(text => ({
      text,
      chars: Array.from(text).map(ch => ({ c: ch, p: '', g: '' })),
      phrases: []
    }))
  };
}

function pickString(source, keys){
  if(!source) return '';
  for(const key of keys){
    const value = source[key];
    if(typeof value === 'string'){
      const trimmed = value.trim();
      if(trimmed) return trimmed;
    }
  }
  return '';
}

function pickInteger(source, keys){
  if(!source) return null;
  for(const key of keys){
    if(!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = Number(source[key]);
    if(Number.isInteger(value)) return value;
  }
  return null;
}

function normaliseTranslation(content, payload){
  const lineMap = new Map();
  if(Array.isArray(payload?.lines)){
    payload.lines.forEach(item => {
      if(!item) return;
      const idx = pickInteger(item, ['index', 'lineIndex', 'line']);
      if(idx === null) return;
      lineMap.set(idx, item);
    });
  }
  const lines = content.originalLines.map((text, index) => {
    const charArr = Array.from(text);
    const chars = charArr.map(ch => ({ c: ch, p: '', g: '' }));
    const phrases = [];
    const payloadLine = lineMap.get(index);
    if(payloadLine){
      if(Array.isArray(payloadLine.chars)){
        payloadLine.chars.forEach(entry => {
          if(!entry) return;
          const i = pickInteger(entry, ['i', 'index', 'idx', 'position']);
          if(i === null || i < 0 || i >= chars.length) return;
          const entryChar = pickString(entry, ['ch', 'char', 'character', 'c', 'text', 'value']);
          if(entryChar && entryChar !== charArr[i]) return;
          const pVal = pickString(entry, ['p', 'pinyin', 'py']);
          if(pVal){
            chars[i].p = pVal;
          }
          const gVal = pickString(entry, ['g', 'gloss', 'meaning', 'translation', 'explanation', 'note', 'interpretation', 'definition', 'def']);
          if(gVal){
            chars[i].g = gVal;
          }
        });
      }
      if(Array.isArray(payloadLine.phrases)){
        payloadLine.phrases.forEach(ph => {
          if(!ph) return;
          let s = pickInteger(ph, ['s', 'start', 'from', 'begin', 'beginIndex']);
          let e = pickInteger(ph, ['e', 'end', 'to', 'finish', 'stop', 'endIndex']);
          if(s === null || e === null) return;
          if(s > e) [s, e] = [e, s];
          if(s < 0 || e >= chars.length) return;
          phrases.push({
            s,
            e,
            p: pickString(ph, ['p', 'pinyin', 'py']),
            g: pickString(ph, ['g', 'gloss', 'meaning', 'translation', 'explanation', 'note', 'interpretation', 'definition', 'def'])
          });
        });
      }
    }
    return { text, chars, phrases };
  });
  const summary = pickString(payload, ['summary', 'desc', 'description']);
  const title = pickString(payload, ['title', 'name', 'heading']);
  return { title, lines, summary };
}

function buildPageHtml(meta, content, translation){
  const docTitle = translation.title || (meta.title || meta.file.replace(/\.txt$/i, ''));
  const now = new Date();
  const stamp = now.toLocaleString();
  const summaryText = translation.summary ? translation.summary.trim() : '';
  const summaryHtml = summaryText ? `<p class="summary">${escapeHtml(summaryText)}</p>` : '';
  const originalHtml = content.originalText ? escapeHtml(content.originalText).replace(/\n/g, '<br />') : '<em>原文件未提供原文。</em>';
  const vernacularHtml = content.vernacular ? escapeHtml(content.vernacular).replace(/\n/g, '<br />') : '<em>原文件未提供白话文内容。</em>';
  const commentHtml = content.comment ? escapeHtml(content.comment).replace(/\n/g, '<br />') : '<em>原文件未提供点评。</em>';
  const textPanelHtml = translation.lines.map((line, lineIndex) => {
    const charsHtml = Array.from(line.text || '').map((ch, charIndex) => {
      const classes = ['char'];
      if(PUNCTUATION_RE.test(ch)){
        classes.push('punct');
      }
      const safeChar = ch === ' ' ? '&nbsp;' : escapeHtml(ch);
      return `<span class="${classes.join(' ')}" data-line="${lineIndex}" data-index="${charIndex}">${safeChar}</span>`;
    }).join('');
    return `<div class="line" data-line="${lineIndex}">${charsHtml}</div>`;
  }).join('');
  const dataPayload = {
    meta: {
      file: meta.file,
      generatedAt: stamp,
      title: docTitle
    },
    lines: translation.lines.map((line, index) => ({
      index,
      text: line.text,
      chars: line.chars.map(cell => ({
        c: cell.c,
        p: cell.p || '',
        g: cell.g || ''
      })),
      phrases: line.phrases.map(ph => ({
        s: ph.s,
        e: ph.e,
        p: ph.p || '',
        g: ph.g || ''
      }))
    }))
  };
  const dataScript = JSON.stringify(dataPayload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${docTitle} · 逐字注释</title>
  <style>
    :root{ --bg:#0b0f14; --card:#121821; --muted:#233044; --text:#e7eef7; --sub:#9db2cf; --accent:#4da3ff; --border:#1c2431; --hl:#1d2a3c; --chip:#22334b; --yellow:#ffd166; }
    *{box-sizing:border-box}
    html,body{height:100%}
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:linear-gradient(180deg,#0b0f14,#0e141d);color:var(--text)}
    .container{max-width:1100px;margin:0 auto;padding:28px;display:grid;gap:20px;grid-template-columns:1.2fr 0.8fr}
    header{grid-column:1/-1;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:18px 20px;display:flex;gap:14px;flex-direction:column}
    header h1{margin:0;font-size:26px;font-weight:700;letter-spacing:0.02em}
    header .summary{margin:0;font-size:15px;color:var(--sub);line-height:1.75}
    header .meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
    .chip{background:var(--chip);border:1px solid var(--border);color:var(--sub);padding:6px 10px;border-radius:999px;font-size:12px}

    .workspace{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:12px}
    .workspace h2{margin:0;font-size:18px}
    .workspace .small{font-size:12px;color:var(--sub)}
    .text-panel{height:70vh;overflow:auto;padding:12px;border-radius:14px;background:#0b111a;border:1px solid var(--border)}
    .line{margin:10px 0;line-height:2.2;font-size:20px}
    .char{display:inline-block;padding:2px 6px;margin:0 2px;border-radius:8px;cursor:pointer;user-select:none;transition:background .15s}
    .char:hover{background:rgba(77,163,255,.1)}
    .char.active{background:rgba(77,163,255,.18);outline:1px dashed rgba(77,163,255,.35)}
    .char.punct{opacity:.6;cursor:default}

    .panel{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:12px}
    .panel h2{margin:2px 0 6px 0;font-size:16px;color:var(--accent)}
    .kv{display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center}
    .kv input,.kv textarea{width:100%;padding:10px 12px;border-radius:12px;background:#0d131c;color:var(--text);border:1px solid var(--border)}
    .kv input[readonly],.kv textarea[readonly]{opacity:.9}
    .kv textarea{min-height:120px;resize:vertical}
    .small{font-size:12px;color:var(--sub)}
    .stat{display:flex;gap:10px;flex-wrap:wrap}
    .stat .chip{background:#152033}
    .rightcol{display:flex;flex-direction:column;gap:12px}
    .full{grid-column:1/-1}
    .full p{margin:0;font-size:14px;line-height:1.9}
    .footer{grid-column:1/-1;text-align:center;color:var(--sub);font-size:12px}

    #bubble{position:fixed;display:none;max-width:320px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px;box-shadow:0 10px 30px rgba(0,0,0,.35);z-index:9999;pointer-events:none}
    #bubble .b-hd{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
    #bubble .b-char{font-size:18px;font-weight:700}
    #bubble .b-pinyin{font-size:14px;color:var(--yellow)}
    #bubble .b-gloss{font-size:13px;color:var(--text)}
    #bubble .b-empty{color:var(--sub);font-style:italic}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${docTitle}</h1>
      ${summaryHtml}
      <div class="meta">
        <span class="chip">来源文件：${escapeHtml(meta.file)}</span>
        <span class="chip">生成时间：${escapeHtml(stamp)}</span>
      </div>
    </header>

    <section class="workspace">
      <h2>逐字与词组释义</h2>
      <p class="small">提示：点击左侧文本中的任意字，若命中已识别的词组会优先显示词组释义。</p>
      <div class="text-panel" id="textPanel" aria-live="polite">${textPanelHtml}</div>
    </section>

    <div class="rightcol">
      <section class="panel" id="phrasePanel">
        <h2>词组释义</h2>
        <div class="small">命中词组时会自动载入此处，字段为只读展示。</div>
        <div class="kv"><div>所在行</div><input id="phLine" readonly placeholder="—" /></div>
        <div class="kv"><div>词组</div><input id="phText" readonly placeholder="词组" /></div>
        <div class="kv"><div>范围</div><input id="phRange" readonly placeholder="s-e" /></div>
        <div class="kv"><div>读音</div><input id="phPinyin" readonly placeholder="拼音" /></div>
        <div class="kv"><div>白话</div><textarea id="phGloss" readonly placeholder="释义"></textarea></div>
      </section>

      <section class="panel" id="sidePanel">
        <h2>单字释义</h2>
        <div class="stat">
          <span class="chip" id="statTitle">${escapeHtml(docTitle)}</span>
          <span class="chip" id="statIndex">—</span>
          <span class="chip" id="statSaved">已收录：字 0 / 词组 0</span>
        </div>
        <div class="kv">
          <div>原字符</div>
          <input id="fieldChar" readonly placeholder="—" />
        </div>
        <div class="kv">
          <div>读音</div>
          <input id="fieldPinyin" readonly placeholder="拼音" />
        </div>
        <div class="kv">
          <div>白话</div>
          <textarea id="fieldGloss" readonly placeholder="释义"></textarea>
        </div>
        <p class="small">说明：本页展示自动批量生成的释义内容。</p>
      </section>
    </div>

    <section class="panel full">
      <h2>原文</h2>
      <p>${originalHtml}</p>
    </section>
    <section class="panel full">
      <h2>原书白话文</h2>
      <p>${vernacularHtml}</p>
    </section>
    <section class="panel full">
      <h2>原书点评</h2>
      <p>${commentHtml}</p>
    </section>

    <div class="footer">本页面由《聊斋志异》逐字注释生成器自动生成。</div>
  </div>

  <div id="bubble" role="tooltip" aria-hidden="true"></div>
  <script>window.PAGE_DATA=${dataScript};</script>
  <script>
    (function(){
      var data = window.PAGE_DATA || { lines: [] };
      var panel = document.getElementById('textPanel');
      var bubble = document.getElementById('bubble');
      var statTitle = document.getElementById('statTitle');
      var statIndex = document.getElementById('statIndex');
      var statSaved = document.getElementById('statSaved');
      var fieldChar = document.getElementById('fieldChar');
      var fieldPinyin = document.getElementById('fieldPinyin');
      var fieldGloss = document.getElementById('fieldGloss');
      var phLine = document.getElementById('phLine');
      var phText = document.getElementById('phText');
      var phRange = document.getElementById('phRange');
      var phPinyin = document.getElementById('phPinyin');
      var phGloss = document.getElementById('phGloss');
      var state = { line: -1, index: -1 };
      var punctuationRe = /[\u3000\s，。、“”《》？！；：（）——…,.!?;:()\-\[\]{}]/;

      function escapeHtml(str){
        return String(str == null ? '' : str).replace(/[&<>\"']/g, function(c){
          return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\'':'&#39;'}[c];
        });
      }

      function clearActive(){
        if(!panel) return;
        var active = panel.querySelectorAll('.char.active');
        Array.prototype.forEach.call(active, function(el){ el.classList.remove('active'); });
      }

      function getLine(lineIndex){
        return (data.lines && data.lines[lineIndex]) || { text: '', chars: [], phrases: [] };
      }

      function getLineText(lineIndex){
        var line = getLine(lineIndex);
        if(line && typeof line.text === 'string' && line.text.length){
          return line.text;
        }
        return (line.chars || []).map(function(cell){ return (cell && cell.c) || ''; }).join('');
      }

      function getPhrase(lineIndex, charIndex){
        var line = getLine(lineIndex);
        var phrases = line.phrases || [];
        for(var i=0;i<phrases.length;i++){
          var ph = phrases[i];
          if(ph && ph.s <= charIndex && ph.e >= charIndex){
            return ph;
          }
        }
        return null;
      }

      function getPhraseText(lineIndex, start, end){
        var text = Array.from(getLineText(lineIndex));
        return text.slice(start, end + 1).join('');
      }

      function highlightRange(lineIndex, start, end){
        if(!panel) return;
        var lineEl = panel.querySelector('.line[data-line="' + lineIndex + '"]');
        if(!lineEl) return;
        for(var i=start;i<=end;i++){
          var span = lineEl.querySelector('.char[data-index="' + i + '"]');
          if(span) span.classList.add('active');
        }
      }

      function showBubble(el, payload){
        if(!bubble || !el) return;
        var gloss = payload.gloss || '';
        var glossHtml = gloss ? escapeHtml(gloss).replace(/\n/g, '<br />') : '<span class="b-empty">暂无释义</span>';
        bubble.innerHTML = '<div class="b-hd"><span class="b-char">' + escapeHtml(payload.title || '—') + '</span><span class="b-pinyin">' + escapeHtml(payload.pinyin || '—') + '</span></div><div class="b-gloss">' + glossHtml + '</div>';
        bubble.style.display = 'block';
        requestAnimationFrame(function(){
          var rect = el.getBoundingClientRect();
          var pad = 8;
          var left = rect.left + window.scrollX;
          var top = rect.bottom + window.scrollY + pad;
          var maxLeft = window.scrollX + window.innerWidth - bubble.offsetWidth - 12;
          if(left > maxLeft) left = maxLeft;
          if(left < window.scrollX + 12) left = window.scrollX + 12;
          bubble.style.left = left + 'px';
          bubble.style.top = top + 'px';
          bubble.setAttribute('aria-hidden', 'false');
        });
      }

      function hideBubble(){
        if(!bubble) return;
        bubble.style.display = 'none';
        bubble.setAttribute('aria-hidden', 'true');
      }

      function showCharDetails(payload){
        if(fieldChar) fieldChar.value = payload ? (payload.char || '') : '';
        if(fieldPinyin) fieldPinyin.value = payload ? (payload.pinyin || '') : '';
        if(fieldGloss) fieldGloss.value = payload ? (payload.gloss || '') : '';
      }

      function showPhraseDetails(payload){
        if(!phLine) return;
        if(payload){
          phLine.value = '第 ' + (payload.line + 1) + ' 行';
          phText.value = payload.text || '';
          phRange.value = payload.range || '';
          phPinyin.value = payload.pinyin || '';
          phGloss.value = payload.gloss || '';
        }else{
          phLine.value = '';
          phText.value = '';
          phRange.value = '';
          phPinyin.value = '';
          phGloss.value = '';
        }
      }

      function updateStats(){
        var charCount = 0;
        var phraseCount = 0;
        (data.lines || []).forEach(function(line){
          if(!line) return;
          (line.chars || []).forEach(function(cell){
            if(!cell) return;
            var hasInfo = (cell.p && cell.p.trim()) || (cell.g && cell.g.trim());
            if(hasInfo) charCount += 1;
          });
          phraseCount += (line.phrases || []).length;
        });
        if(statTitle){
          statTitle.textContent = (data.meta && data.meta.title) ? data.meta.title : '逐字注释';
        }
        if(statSaved){
          statSaved.textContent = '已收录：字 ' + charCount + ' / 词组 ' + phraseCount;
        }
        if(statIndex){
          statIndex.textContent = state.line >= 0 ? ('第' + (state.line + 1) + '行·第' + (state.index + 1) + '字') : '—';
        }
      }

      function onCharClick(ev){
        var el = ev.currentTarget;
        var lineIndex = Number(el.getAttribute('data-line'));
        var charIndex = Number(el.getAttribute('data-index'));
        var line = getLine(lineIndex);
        var chars = line.chars || [];
        var cell = chars[charIndex] || { c: el.textContent || '' };
        var phrase = getPhrase(lineIndex, charIndex);
        clearActive();
        state.line = lineIndex;
        state.index = charIndex;
        var charPayload = {
          char: cell.c || el.textContent || '',
          pinyin: cell.p || '',
          gloss: cell.g || ''
        };
        if(phrase){
          highlightRange(lineIndex, phrase.s, phrase.e);
          var phraseText = getPhraseText(lineIndex, phrase.s, phrase.e);
          var phrasePayload = {
            line: lineIndex,
            text: phraseText,
            range: phrase.s + '-' + phrase.e,
            pinyin: phrase.p || cell.p || '',
            gloss: phrase.g || cell.g || ''
          };
          showPhraseDetails(phrasePayload);
          showBubble(el, { title: phraseText, pinyin: phrasePayload.pinyin, gloss: phrasePayload.gloss });
        }else{
          el.classList.add('active');
          showPhraseDetails(null);
          showBubble(el, { title: charPayload.char, pinyin: charPayload.pinyin, gloss: charPayload.gloss });
        }
        showCharDetails(charPayload);
        updateStats();
      }

      function attachListeners(){
        if(!panel) return;
        var spans = panel.querySelectorAll('.char');
        Array.prototype.forEach.call(spans, function(span){
          if(span.classList.contains('punct')) return;
          span.addEventListener('click', onCharClick);
        });
      }

      function resetView(){
        state.line = -1;
        state.index = -1;
        clearActive();
        showCharDetails(null);
        showPhraseDetails(null);
        updateStats();
        hideBubble();
      }

      attachListeners();
      updateStats();

      document.addEventListener('click', function(ev){
        if(ev.target.closest('.char') || ev.target.closest('#bubble')) return;
        resetView();
      });

      document.addEventListener('keydown', function(ev){
        if(ev.key === 'Escape'){
          resetView();
        }
      });

      document.addEventListener('scroll', hideBubble, true);
    })();
  </script>
</body>
</html>`;
}

function buildNavigationPage(entries){
  const linksHtml = entries.map(item => `    <li><a href="${escapeHtml(item.outputName)}">${escapeHtml(item.title)}</a></li>`).join('\n');
  return `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>聊斋逐字注释导航</title>
  <style>
    body{margin:0;font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;background:#0b111a;color:#e8efff;padding:28px;line-height:1.8}
    h1{margin-top:0;font-size:28px}
    ul{list-style:decimal;padding-left:22px}
    a{color:#4da3ff;text-decoration:none}
    a:hover{text-decoration:underline}
    footer{margin-top:32px;font-size:12px;color:#8da0bf}
  </style>
</head>
<body>
  <h1>聊斋逐字注释导航</h1>
  <p>本导航列出生成的逐字注释页面，请与注释文件放置在同一目录后离线打开。</p>
  <ul>
${linksHtml}
  </ul>
  <footer>生成时间：${escapeHtml(new Date().toLocaleString())}</footer>
</body>
</html>`;
}

function escapeHtml(str){
  return String(str).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\'':'&#39;'}[c]));
}

main().catch(err => {
  console.error('[ERROR]', err.message);
  process.exitCode = 1;
});
