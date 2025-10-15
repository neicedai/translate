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
  const vernacularHtml = content.vernacular ? escapeHtml(content.vernacular).replace(/\n/g, '<br />') : '<em>原文件未提供白话文内容。</em>';
  const commentHtml = content.comment ? escapeHtml(content.comment).replace(/\n/g, '<br />') : '<em>原文件未提供点评。</em>';
  const originalHtml = content.originalText ? escapeHtml(content.originalText).replace(/\n/g, '<br />') : '';
  const summaryHtml = translation.summary ? `<p class="meta">${escapeHtml(translation.summary)}</p>` : '';
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
      generatedAt: stamp
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
    :root{--bg:#0b0f14;--card:#121821;--border:#1c2431;--text:#e7eef7;--sub:#9db2cf;--accent:#4da3ff;--hl:#1d2a3c;--chip:#22334b;--yellow:#ffd166;}
    *{box-sizing:border-box}
    body{margin:0;font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;background:linear-gradient(180deg,#0b0f14,#0f1621);color:var(--text);line-height:1.8;padding:26px}
    header{margin-bottom:24px}
    h1{margin:0;font-size:28px}
    .meta{color:var(--sub);font-size:13px;margin-top:6px}
    .layout{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,0.8fr);gap:20px;align-items:start}
    .panel{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:18px}
    .panel h2{margin-top:0;font-size:20px;color:var(--accent)}
    .text-panel{background:#0b111a;border:1px solid var(--border);border-radius:16px;padding:16px;height:70vh;overflow:auto}
    .line{margin-bottom:14px;font-size:20px;line-height:1.9}
    .line:last-child{margin-bottom:0}
    .char{display:inline-block;padding:4px 7px;margin:0 2px;border-radius:10px;cursor:pointer;transition:background .15s}
    .char:hover{background:rgba(77,163,255,.12)}
    .char.active{background:rgba(77,163,255,.22);outline:1px dashed rgba(77,163,255,.3)}
    .char.punct{opacity:.55;cursor:default;pointer-events:none}
    .info-panel{display:flex;flex-direction:column;gap:16px}
    .info-meta{display:flex;gap:8px;flex-wrap:wrap}
    .info-chip{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;border:1px solid var(--border);background:var(--chip);color:var(--sub);font-size:12px}
    .info-chip.accent{background:rgba(77,163,255,.15);color:var(--text);border-color:rgba(77,163,255,.4)}
    .info-section{border:1px solid rgba(77,163,255,.14);background:rgba(77,163,255,.06);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px}
    .info-section[hidden]{display:none}
    .info-section h3{margin:0;font-size:15px;color:var(--accent)}
    .info-row{display:grid;grid-template-columns:66px 1fr;gap:8px;align-items:flex-start;font-size:14px}
    .info-label{color:var(--sub)}
    .info-value{color:var(--text);word-break:break-word;white-space:pre-wrap}
    .info-muted{color:var(--sub);font-style:italic}
    .bubble{position:fixed;display:none;max-width:320px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;box-shadow:0 14px 32px rgba(0,0,0,.45);z-index:9999;pointer-events:none}
    .bubble .b-hd{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
    .bubble .b-title{font-size:18px;font-weight:700}
    .bubble .b-pinyin{font-size:14px;color:var(--yellow)}
    .bubble .b-gloss{font-size:13px;color:var(--text)}
    .bubble .b-empty{color:var(--sub);font-style:italic}
    .section{margin-top:24px}
    .section h2{margin-top:0;font-size:22px;color:var(--accent)}
    .section p{margin:0;font-size:15px;white-space:pre-wrap}
    footer{margin-top:36px;font-size:12px;color:var(--sub)}
  </style>
</head>
<body>
  <header>
    <h1>${docTitle}</h1>
    ${summaryHtml}
    <p class="meta">生成时间：${escapeHtml(stamp)} · 来源文件：${escapeHtml(meta.file)}</p>
  </header>
  <main class="layout">
    <section class="panel">
      <h2>逐字·词组释义</h2>
      <div class="text-panel" id="textPanel" aria-live="polite">${textPanelHtml}</div>
    </section>
    <aside class="panel info-panel">
      <h2>当前释义</h2>
      <div class="info-meta">
        <span class="info-chip" id="infoLine">未选择</span>
        <span class="info-chip" id="infoIndex">—</span>
      </div>
      <div class="info-section" id="phraseSection" hidden>
        <h3>词组释义</h3>
        <div class="info-row"><span class="info-label">词组</span><span class="info-value" id="infoPhraseTarget">—</span></div>
        <div class="info-row"><span class="info-label">拼音</span><span class="info-value" id="infoPhrasePinyin">—</span></div>
        <div class="info-row"><span class="info-label">释义</span><span class="info-value" id="infoPhraseGloss"><span class="info-muted">暂无释义</span></span></div>
      </div>
      <div class="info-section" id="charSection">
        <h3>单字释义</h3>
        <div class="info-row"><span class="info-label">字</span><span class="info-value" id="infoCharTarget">—</span></div>
        <div class="info-row"><span class="info-label">拼音</span><span class="info-value" id="infoCharPinyin">—</span></div>
        <div class="info-row"><span class="info-label">释义</span><span class="info-value" id="infoCharGloss"><span class="info-muted">暂无释义</span></span></div>
      </div>
    </aside>
  </main>
  <section class="panel section">
    <h2>原文</h2>
    <p>${originalHtml}</p>
  </section>
  <section class="panel section">
    <h2>原书白话文</h2>
    <p>${vernacularHtml}</p>
  </section>
  <section class="panel section">
    <h2>原书点评</h2>
    <p>${commentHtml}</p>
  </section>
  <footer>本页面由《聊斋志异》逐字注释生成器自动生成。</footer>
  <div id="bubble" class="bubble" role="status" aria-hidden="true"></div>
  <script>window.PAGE_DATA=${dataScript};</script>
  <script>
    (function(){
      const data = window.PAGE_DATA || { lines: [] };
      const panel = document.getElementById('textPanel');
      const infoLine = document.getElementById('infoLine');
      const infoIndex = document.getElementById('infoIndex');
      const phraseSection = document.getElementById('phraseSection');
      const infoPhraseTarget = document.getElementById('infoPhraseTarget');
      const infoPhrasePinyin = document.getElementById('infoPhrasePinyin');
      const infoPhraseGloss = document.getElementById('infoPhraseGloss');
      const infoCharTarget = document.getElementById('infoCharTarget');
      const infoCharPinyin = document.getElementById('infoCharPinyin');
      const infoCharGloss = document.getElementById('infoCharGloss');
      const bubble = document.getElementById('bubble');
      const punctuationRe = /[，。！？、；：、“”‘’（）《》〈〉【】『』]/;
      function escapeHtml(str){
        return str.replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\\'':'&#39;'}[c]));
      }
      function clearActive(){
        if(!panel) return;
        panel.querySelectorAll('.char.active').forEach(el => el.classList.remove('active'));
      }
      function setText(el, value, fallback='—'){
        if(!el) return;
        const str = typeof value === 'string' ? value.trim() : '';
        el.textContent = str ? str : fallback;
      }
      function setGloss(el, value){
        if(!el) return;
        const str = typeof value === 'string' ? value.trim() : '';
        if(!str){
          el.innerHTML = '<span class="info-muted">暂无释义</span>';
        }else{
          el.innerHTML = escapeHtml(str).replace(/\n/g, '<br />');
        }
      }
      function updateInfo(detail){
        if(!detail){
          setText(infoLine, '', '未选择');
          setText(infoIndex, '', '—');
          setText(infoCharTarget, '', '—');
          setText(infoCharPinyin, '', '—');
          setGloss(infoCharGloss, '');
          phraseSection.hidden = true;
          setGloss(infoPhraseGloss, '');
          setText(infoPhraseTarget, '', '—');
          setText(infoPhrasePinyin, '', '—');
          return;
        }
        setText(infoLine, '第' + (detail.lineIndex + 1) + '行', '未选择');
        setText(infoIndex, '第' + (detail.charIndex + 1) + '字', '—');
        setText(infoCharTarget, detail.char || '', '—');
        setText(infoCharPinyin, detail.charPinyin || '', '—');
        setGloss(infoCharGloss, detail.charGloss || '');
        if(detail.phrase){
          phraseSection.hidden = false;
          setText(infoPhraseTarget, detail.phrase.text || '', '—');
          setText(infoPhrasePinyin, detail.phrase.pinyin || '', '—');
          setGloss(infoPhraseGloss, detail.phrase.gloss || '');
        }else{
          phraseSection.hidden = true;
          setGloss(infoPhraseGloss, '');
          setText(infoPhraseTarget, '', '—');
          setText(infoPhrasePinyin, '', '—');
        }
      }
      function getLine(lineIndex){
        return data.lines[lineIndex] || { text: '', chars: [], phrases: [] };
      }
      function getPhrase(lineIndex, charIndex){
        const line = getLine(lineIndex);
        return (line.phrases || []).find(ph => ph.s <= charIndex && ph.e >= charIndex) || null;
      }
      function getPhraseText(lineIndex, start, end){
        const line = getLine(lineIndex);
        return Array.from(line.text || '').slice(start, end + 1).join('');
      }
      function showBubble(el, payload){
        if(!bubble || !el) return;
        bubble.innerHTML = '<div class="b-hd"><span class="b-title">' + escapeHtml(payload.title || '—') + '</span><span class="b-pinyin">' + escapeHtml(payload.pinyin || '—') + '</span></div><div class="b-gloss">' + (payload.gloss ? escapeHtml(payload.gloss) : '<span class="b-empty">暂无释义</span>') + '</div>';
        bubble.style.display = 'block';
        const rect = el.getBoundingClientRect();
        let left = rect.left + window.scrollX;
        const top = rect.bottom + window.scrollY + 10;
        const maxLeft = window.scrollX + window.innerWidth - bubble.offsetWidth - 16;
        if(left > maxLeft) left = maxLeft;
        if(left < window.scrollX + 16) left = window.scrollX + 16;
        bubble.style.left = left + 'px';
        bubble.style.top = top + 'px';
        bubble.setAttribute('aria-hidden', 'false');
      }
      function hideBubble(){
        if(!bubble) return;
        bubble.style.display = 'none';
        bubble.setAttribute('aria-hidden', 'true');
      }
      function handleCharClick(ev){
        const el = ev.currentTarget;
        const lineIndex = Number(el.dataset.line);
        const charIndex = Number(el.dataset.index);
        const line = getLine(lineIndex);
        const cell = (line.chars || [])[charIndex] || { c: el.textContent || '' };
        const phrase = getPhrase(lineIndex, charIndex);
        clearActive();
        el.classList.add('active');
        const charText = cell.c || el.textContent || '';
        const charPinyin = cell.p || '';
        const charGloss = cell.g || '';
        const detail = {
          lineIndex,
          charIndex,
          char: charText,
          charPinyin,
          charGloss,
          phrase: null
        };
        let bubblePayload;
        if(phrase){
          const phraseText = getPhraseText(lineIndex, phrase.s, phrase.e);
          detail.phrase = {
            text: phraseText,
            pinyin: phrase.p || '',
            gloss: phrase.g || ''
          };
          bubblePayload = {
            title: phraseText,
            pinyin: detail.phrase.pinyin || charPinyin,
            gloss: detail.phrase.gloss || charGloss
          };
        }else{
          bubblePayload = {
            title: charText,
            pinyin: charPinyin,
            gloss: charGloss
          };
        }
        updateInfo(detail);
        showBubble(el, bubblePayload);
      }
      function enhancePanel(){
        if(!panel) return;
        if(panel.children.length){
          panel.querySelectorAll('.char').forEach(span => {
            if(span.classList.contains('punct')) return;
            span.addEventListener('click', handleCharClick);
          });
          return;
        }
        data.lines.forEach(line => {
          const lineEl = document.createElement('div');
          lineEl.className = 'line';
          Array.from(line.text || '').forEach((ch, idx) => {
            const span = document.createElement('span');
            span.className = 'char';
            span.textContent = ch === ' ' ? '\u00a0' : ch;
            span.dataset.line = line.index;
            span.dataset.index = idx;
            if(punctuationRe.test(ch)){
              span.classList.add('punct');
            }else{
              span.addEventListener('click', handleCharClick);
            }
            lineEl.appendChild(span);
          });
          panel.appendChild(lineEl);
        });
      }

      enhancePanel();
      document.addEventListener('click', ev => {
        if(ev.target.closest('.char')) return;
        if(ev.target.closest('.bubble')) return;
        clearActive();
        updateInfo(null);
        hideBubble();
      });
      document.addEventListener('keydown', ev => {
        if(ev.key === 'Escape'){
          clearActive();
          updateInfo(null);
          hideBubble();
        }
      });
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
