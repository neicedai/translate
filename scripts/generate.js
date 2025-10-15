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
    .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .toolbar .spacer{flex:1}
    .btn{background:var(--hl);border:1px solid var(--border);color:var(--text);padding:9px 12px;border-radius:12px;font-size:13px;cursor:pointer;transition:border-color .15s ease}
    .btn.secondary{background:transparent;color:var(--sub)}
    .btn:hover{border-color:#2d3b52}
    .btn.toggle.active{outline:2px solid var(--accent)}
    .btn:disabled{opacity:.5;cursor:not-allowed}
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
    .kv input[readonly],.kv textarea[readonly]{opacity:.85}
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
      <div class="toolbar">
        <button class="btn toggle" id="togglePhrase">词组注释模式</button>
        <button class="btn secondary" id="resetSelection">清空选中</button>
        <span class="spacer"></span>
        <button class="btn secondary" id="exportJson">导出注释 JSON</button>
      </div>
      <p class="small">提示：点击左侧文本中的任意字，若命中已保存的词组会自动载入右侧词组面板；开启“词组注释模式”后先点起始字再点结束字，即可调整词组范围。</p>
      <div class="text-panel" id="textPanel" aria-live="polite"></div>
    </section>

    <div class="rightcol">
      <section class="panel" id="phrasePanel">
        <h2>词组释义</h2>
        <div class="small">命中词组时会自动载入此处，可补充或修改拼音、释义。</div>
        <div class="kv"><div>所在行</div><input id="phLine" readonly placeholder="—" /></div>
        <div class="kv"><div>词组</div><input id="phText" placeholder="词组" /></div>
        <div class="kv"><div>范围</div><input id="phRange" readonly placeholder="s-e" /></div>
        <div class="kv"><div>读音</div><input id="phPinyin" placeholder="拼音" /></div>
        <div class="kv"><div>白话</div><textarea id="phGloss" placeholder="释义"></textarea></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="phSave">保存词组注释</button>
          <button class="btn secondary" id="phDelete">删除该词组</button>
        </div>
        <p class="small">提示：可在词组模式下重新选取范围，再点击“保存词组注释”覆盖原记录。</p>
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
          <input id="fieldPinyin" placeholder="拼音" />
        </div>
        <div class="kv">
          <div>白话</div>
          <textarea id="fieldGloss" placeholder="释义"></textarea>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="saveNote">保存注释</button>
          <button class="btn secondary" id="deleteNote">删除该字注释</button>
        </div>
        <p class="small">说明：修改内容会自动保存到浏览器本地存储，可随时导出为 JSON。</p>
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
      var meta = data.meta || {};
      var baseTitle = meta.title || document.title || '';
      var linesSource = Array.isArray(data.lines) ? data.lines : [];
      var baseLines = [];
      var basePhrases = {};
      var lineTexts = [];
      for(var i=0;i<linesSource.length;i++){
        var lineObj = linesSource[i] || {};
        var textLine = '';
        if(typeof lineObj.text === 'string' && lineObj.text.length){
          textLine = lineObj.text;
        }else if(Array.isArray(lineObj.chars)){
          textLine = lineObj.chars.map(function(cell){ return (cell && cell.c) || ''; }).join('');
        }
        lineTexts[i] = textLine;
        var charList = Array.isArray(lineObj.chars) && lineObj.chars.length ? lineObj.chars : Array.from(textLine).map(function(ch){ return { c: ch, p: '', g: '' }; });
        baseLines[i] = charList.map(function(cell, idx){
          var ch = (cell && cell.c) || textLine[idx] || '';
          return { c: ch, p: (cell && cell.p) || '', g: (cell && cell.g) || '' };
        });
        if(Array.isArray(lineObj.phrases) && lineObj.phrases.length){
          basePhrases[i] = lineObj.phrases.map(function(ph){
            var s = Number(ph && ph.s);
            var e = Number(ph && ph.e);
            if(!Number.isInteger(s) || !Number.isInteger(e)) return null;
            if(s > e){ var tmp = s; s = e; e = tmp; }
            return { s: s, e: e, p: (ph && ph.p) || '', g: (ph && ph.g) || '' };
          }).filter(Boolean);
        }
      }

      function cloneBaseNotes(){
        var clone = { title: baseTitle, lines: [], phrases: {} };
        for(var i=0;i<baseLines.length;i++){
          var row = baseLines[i] || [];
          clone.lines[i] = row.map(function(cell){
            return { c: cell.c || '', p: cell.p || '', g: cell.g || '' };
          });
        }
        for(var key in basePhrases){
          if(!Object.prototype.hasOwnProperty.call(basePhrases, key)) continue;
          clone.phrases[key] = (basePhrases[key] || []).map(function(ph){
            return { s: ph.s, e: ph.e, p: ph.p || '', g: ph.g || '' };
          });
        }
        return clone;
      }

      var storeKey = 'liaozhai_gen_' + (meta.file || baseTitle || 'page');
      var store = {
        load: function(){
          try{
            var raw = localStorage.getItem(storeKey);
            if(!raw) return null;
            return JSON.parse(raw);
          }catch(err){
            console.warn('[WARN] 无法读取本地存储记录：', err);
            return null;
          }
        },
        save: function(payload){
          try{
            localStorage.setItem(storeKey, JSON.stringify(payload));
          }catch(err){
            console.warn('[WARN] 无法保存到本地存储：', err);
          }
        },
        clear: function(){
          try{ localStorage.removeItem(storeKey); }catch(err){ console.warn('[WARN] 无法清除本地存储：', err); }
        }
      };

      function isValidStored(obj){
        if(!obj || !Array.isArray(obj.lines)) return false;
        if(obj.lines.length !== baseLines.length) return false;
        for(var i=0;i<baseLines.length;i++){
          if(!Array.isArray(obj.lines[i]) || obj.lines[i].length !== baseLines[i].length){
            return false;
          }
        }
        return true;
      }

      function mergeStored(base, stored){
        if(stored && typeof stored.title === 'string'){
          var t = stored.title.trim();
          if(t) base.title = t;
        }
        for(var i=0;i<base.lines.length;i++){
          var rowBase = base.lines[i];
          var rowStored = Array.isArray(stored.lines[i]) ? stored.lines[i] : [];
          for(var j=0;j<rowBase.length;j++){
            var target = rowBase[j];
            var source = rowStored[j] || {};
            if(source && typeof source.c === 'string' && source.c) target.c = source.c;
            if(source && typeof source.p === 'string') target.p = source.p;
            if(source && typeof source.g === 'string') target.g = source.g;
          }
        }
        var mergedPhrases = {};
        for(var key in base.phrases){
          if(!Object.prototype.hasOwnProperty.call(base.phrases, key)) continue;
          mergedPhrases[key] = base.phrases[key].map(function(ph){ return { s: ph.s, e: ph.e, p: ph.p || '', g: ph.g || '' }; });
        }
        if(stored && stored.phrases && typeof stored.phrases === 'object'){
          for(var skey in stored.phrases){
            if(!Object.prototype.hasOwnProperty.call(stored.phrases, skey)) continue;
            var arr = stored.phrases[skey];
            if(!Array.isArray(arr)) continue;
            mergedPhrases[skey] = arr.map(function(ph){
              var s = Number(ph && ph.s);
              var e = Number(ph && ph.e);
              if(!Number.isInteger(s) || !Number.isInteger(e)) return null;
              if(s > e){ var tmp = s; s = e; e = tmp; }
              return { s: s, e: e, p: (ph && ph.p) || '', g: (ph && ph.g) || '' };
            }).filter(Boolean);
          }
        }
        base.phrases = mergedPhrases;
        return base;
      }

      var notes = cloneBaseNotes();
      var storedNotes = store.load();
      if(isValidStored(storedNotes)){
        notes = mergeStored(cloneBaseNotes(), storedNotes);
      }

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
      var saveBtn = document.getElementById('saveNote');
      var deleteBtn = document.getElementById('deleteNote');
      var toggleBtn = document.getElementById('togglePhrase');
      var resetBtn = document.getElementById('resetSelection');
      var exportBtn = document.getElementById('exportJson');
      var phSaveBtn = document.getElementById('phSave');
      var phDeleteBtn = document.getElementById('phDelete');
      var state = { line: -1, index: -1 };
      var phraseMode = false;
      var phraseStart = null;
      var phraseCurrent = { line: -1, s: -1, e: -1 };
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

      function saveToStore(){
        store.save({ title: notes.title || baseTitle, lines: notes.lines, phrases: notes.phrases });
      }

      function getLineText(lineIndex){
        if(typeof lineTexts[lineIndex] === 'string'){
          return lineTexts[lineIndex];
        }
        var row = notes.lines[lineIndex] || [];
        return row.map(function(cell){ return (cell && cell.c) || ''; }).join('');
      }

      function getPhrase(lineIndex, start, end){
        var list = (notes.phrases && notes.phrases[lineIndex]) || [];
        for(var i=0;i<list.length;i++){
          var ph = list[i];
          if(ph && ph.s === start && ph.e === end){
            return ph;
          }
        }
        return null;
      }

      function findPhraseByIndex(lineIndex, charIndex){
        var list = (notes.phrases && notes.phrases[lineIndex]) || [];
        for(var i=0;i<list.length;i++){
          var ph = list[i];
          if(ph && ph.s <= charIndex && ph.e >= charIndex){
            return ph;
          }
        }
        return null;
      }

      function getPhraseText(lineIndex, start, end){
        var chars = Array.from(getLineText(lineIndex));
        return chars.slice(start, end + 1).join('');
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
        if(fieldChar) fieldChar.value = payload && payload.char ? payload.char : '';
        if(fieldPinyin) fieldPinyin.value = payload && payload.pinyin ? payload.pinyin : '';
        if(fieldGloss) fieldGloss.value = payload && payload.gloss ? payload.gloss : '';
      }

      function showPhraseDetails(payload){
        if(phLine) phLine.value = payload && typeof payload.line === 'number' ? '第 ' + (payload.line + 1) + ' 行' : '';
        if(phText) phText.value = payload && payload.text ? payload.text : '';
        if(phRange) phRange.value = payload && payload.range ? payload.range : '';
        if(phPinyin) phPinyin.value = payload && payload.pinyin ? payload.pinyin : '';
        if(phGloss) phGloss.value = payload && payload.gloss ? payload.gloss : '';
        if(payload){
          phraseCurrent.line = payload.line;
          var parts = (payload.range || '').split('-');
          var s = Number(parts[0]);
          var e = Number(parts[1]);
          if(Number.isInteger(s) && Number.isInteger(e)){
            phraseCurrent.s = s;
            phraseCurrent.e = e;
          }
        }else{
          phraseCurrent = { line: -1, s: -1, e: -1 };
        }
      }

      function updateStats(){
        var charCount = 0;
        for(var i=0;i<notes.lines.length;i++){
          var row = notes.lines[i];
          if(!Array.isArray(row)) continue;
          for(var j=0;j<row.length;j++){
            var cell = row[j];
            if(cell && ((cell.p && cell.p.trim()) || (cell.g && cell.g.trim()))) charCount++;
          }
        }
        var phraseCount = 0;
        if(notes.phrases){
          for(var key in notes.phrases){
            if(!Object.prototype.hasOwnProperty.call(notes.phrases, key)) continue;
            var arr = notes.phrases[key];
            if(Array.isArray(arr)) phraseCount += arr.length;
          }
        }
        if(statTitle){
          var titleText = notes.title || baseTitle || '';
          statTitle.textContent = titleText ? '《' + titleText + '》' : '—';
        }
        if(statSaved){
          statSaved.textContent = '已收录：字 ' + charCount + ' / 词组 ' + phraseCount;
        }
        if(statIndex){
          statIndex.textContent = state.line >= 0 ? ('第' + (state.line + 1) + '行·第' + (state.index + 1) + '字') : '—';
        }
      }

      function ensurePhraseStore(li){
        if(!notes.phrases) notes.phrases = {};
        if(!Array.isArray(notes.phrases[li])) notes.phrases[li] = [];
        return notes.phrases[li];
      }

      function loadPhraseEditor(li, s, e, highlight){
        var text = getPhraseText(li, s, e);
        phraseCurrent = { line: li, s: s, e: e };
        if(phLine) phLine.value = '第 ' + (li + 1) + ' 行';
        if(phText) phText.value = text;
        if(phRange) phRange.value = s + '-' + e;
        var exist = getPhrase(li, s, e) || {};
        if(phPinyin) phPinyin.value = exist.p || '';
        if(phGloss) phGloss.value = exist.g || '';
        clearActive();
        if(highlight !== false){
          highlightRange(li, s, e);
        }
      }

      function upsertPhrase(li, s, e, p, g){
        var arr = ensurePhraseStore(li);
        var record = { s: s, e: e, p: p || '', g: g || '' };
        var idx = -1;
        for(var i=0;i<arr.length;i++){
          if(arr[i] && arr[i].s === s && arr[i].e === e){
            idx = i;
            break;
          }
        }
        if(idx >= 0){
          arr[idx] = record;
        }else{
          arr.push(record);
        }
      }

      function removePhrase(li, s, e){
        if(!notes.phrases || !Array.isArray(notes.phrases[li])) return;
        notes.phrases[li] = notes.phrases[li].filter(function(item){
          return !(item && item.s === s && item.e === e);
        });
      }

      function render(lines){
        if(!panel) return;
        panel.innerHTML = '';
        for(var li=0;li<lines.length;li++){
          var line = lines[li] || '';
          var div = document.createElement('div');
          div.className = 'line';
          div.setAttribute('data-line', li);
          Array.from(line).forEach(function(ch, ci){
            var span = document.createElement('span');
            span.textContent = ch;
            span.className = 'char' + (punctuationRe.test(ch) ? ' punct' : '');
            span.setAttribute('data-line', li);
            span.setAttribute('data-index', ci);
            if(!punctuationRe.test(ch)){
              span.addEventListener('click', onCharClick);
            }
            div.appendChild(span);
          });
          panel.appendChild(div);
        }
      }

      function onCharClick(ev){
        var el = ev.currentTarget;
        var lineIndex = Number(el.getAttribute('data-line'));
        var charIndex = Number(el.getAttribute('data-index'));
        var row = notes.lines[lineIndex] || [];
        var cell = row[charIndex] || { c: el.textContent || '' };
        if(phraseMode){
          if(phraseStart && phraseStart.line === lineIndex){
            var s = Math.min(phraseStart.index, charIndex);
            var e = Math.max(phraseStart.index, charIndex);
            phraseStart = null;
            loadPhraseEditor(lineIndex, s, e, true);
            return;
          }
          phraseStart = { line: lineIndex, index: charIndex };
          clearActive();
          el.classList.add('active');
          return;
        }
        var phrase = findPhraseByIndex(lineIndex, charIndex);
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

      function resetView(){
        state.line = -1;
        state.index = -1;
        phraseCurrent = { line: -1, s: -1, e: -1 };
        clearActive();
        showCharDetails(null);
        showPhraseDetails(null);
        updateStats();
        hideBubble();
      }

      render(lineTexts);
      updateStats();

      document.addEventListener('click', function(ev){
        if(ev.target.closest('.char') || ev.target.closest('#bubble')) return;
        phraseStart = null;
        resetView();
      });

      document.addEventListener('keydown', function(ev){
        if(ev.key === 'Escape'){
          phraseStart = null;
          resetView();
        }
      });

      document.addEventListener('scroll', hideBubble, true);

      if(toggleBtn){
        toggleBtn.addEventListener('click', function(){
          phraseMode = !phraseMode;
          phraseStart = null;
          toggleBtn.classList.toggle('active', phraseMode);
          toggleBtn.textContent = phraseMode ? '词组注释模式（已开启）' : '词组注释模式';
        });
      }

      if(resetBtn){
        resetBtn.addEventListener('click', function(){
          phraseStart = null;
          resetView();
        });
      }

      if(exportBtn){
        exportBtn.addEventListener('click', function(){
          var payload = {
            title: notes.title || baseTitle,
            lines: notes.lines,
            phrases: notes.phrases
          };
          var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          var name = (notes.title || baseTitle || '聊斋注释').replace(/[\\/:*?"<>|]/g, '_');
          a.download = name + '_逐字注释.json';
          a.click();
          URL.revokeObjectURL(a.href);
        });
      }

      if(saveBtn){
        saveBtn.addEventListener('click', function(){
          if(state.line < 0 || state.index < 0){
            alert('请先点击左侧文本中的某个字');
            return;
          }
          var lineIdx = state.line;
          var charIdx = state.index;
          var row = notes.lines[lineIdx] || [];
          var baseChar = (row[charIdx] && row[charIdx].c) || getLineText(lineIdx)[charIdx] || '';
          var pVal = fieldPinyin ? fieldPinyin.value.trim() : '';
          var gVal = fieldGloss ? fieldGloss.value.trim() : '';
          row[charIdx] = { c: baseChar, p: pVal, g: gVal };
          notes.lines[lineIdx] = row;
          saveToStore();
          updateStats();
          var charEl = panel && panel.querySelector('.char[data-line="' + lineIdx + '"][data-index="' + charIdx + '"]');
          if(charEl){
            showBubble(charEl, { title: baseChar, pinyin: pVal, gloss: gVal });
          }
        });
      }

      if(deleteBtn){
        deleteBtn.addEventListener('click', function(){
          if(state.line < 0 || state.index < 0) return;
          var lineIdx = state.line;
          var charIdx = state.index;
          var row = notes.lines[lineIdx] || [];
          var baseChar = (row[charIdx] && row[charIdx].c) || getLineText(lineIdx)[charIdx] || '';
          row[charIdx] = { c: baseChar, p: '', g: '' };
          notes.lines[lineIdx] = row;
          if(fieldPinyin) fieldPinyin.value = '';
          if(fieldGloss) fieldGloss.value = '';
          saveToStore();
          updateStats();
          hideBubble();
        });
      }

      if(phSaveBtn){
        phSaveBtn.addEventListener('click', function(){
          if(phraseCurrent.line < 0 || phraseCurrent.s < 0 || phraseCurrent.e < 0){
            alert('请先在词组模式下选中起止字');
            return;
          }
          var textVal = phText ? phText.value.trim() : '';
          if(!textVal){
            alert('词组不能为空');
            return;
          }
          var pVal = phPinyin ? phPinyin.value.trim() : '';
          var gVal = phGloss ? phGloss.value.trim() : '';
          upsertPhrase(phraseCurrent.line, phraseCurrent.s, phraseCurrent.e, pVal, gVal);
          saveToStore();
          updateStats();
          var firstChar = panel && panel.querySelector('.char[data-line="' + phraseCurrent.line + '"][data-index="' + phraseCurrent.s + '"]');
          if(firstChar){
            showBubble(firstChar, { title: getPhraseText(phraseCurrent.line, phraseCurrent.s, phraseCurrent.e), pinyin: pVal, gloss: gVal });
          }
        });
      }

      if(phDeleteBtn){
        phDeleteBtn.addEventListener('click', function(){
          if(phraseCurrent.line < 0 || phraseCurrent.s < 0 || phraseCurrent.e < 0) return;
          removePhrase(phraseCurrent.line, phraseCurrent.s, phraseCurrent.e);
          if(phPinyin) phPinyin.value = '';
          if(phGloss) phGloss.value = '';
          saveToStore();
          updateStats();
          resetView();
        });
      }
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
