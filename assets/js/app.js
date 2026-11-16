import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { hydrateIcons, icon, initTheme, toggleTheme } from './icons.js';
import { kv } from './store.js';
import { buildPdf, FONT_BASELINE, arrowHead, pageNumberText } from './export.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

/* =========================================================================
   State
   ========================================================================= */
const $ = id => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  sources: [],            // [{ name, bytes: Uint8Array, doc: PDFDocumentProxy }]
  pages: [],              // [{ id, src, index, rotation, bw, bh, annots: [] }]
  settings: { watermark: null, pageNumbers: null },
  meta: { title: '', author: '', subject: '', keywords: '' },
  zoom: 1,
  tool: 'select',
  sel: null,              // { pageId, id }
  editing: null,          // { pageId, id }
  current: 0,
  fileName: 'Untitled.pdf',
};

const style = { color: '#111827', fill: 'none', width: 2, size: 16, font: 'Helvetica', bold: false, italic: false, opacity: 1, hl: '#facc15', wo: '#ffffff' };

const COLORS = ['#111827', '#ef4444', '#f97316', '#eab308', '#22c55e', '#0ea5e9', '#4f46e5', '#a855f7', '#ec4899', '#ffffff'];
const HL_COLORS = ['#facc15', '#4ade80', '#38bdf8', '#f472b6', '#fb923c', '#a78bfa'];
// Single quotes only: these values are embedded inside style="…" attributes
const FONT_CSS = { Helvetica: 'Helvetica, Arial, sans-serif', Times: "'Times New Roman', Times, serif", Courier: "'Courier New', Courier, monospace" };
const BLANK_PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

const TOOLS = [
  { id: 'select', icon: 'pointer', tip: 'Select & move (V)', key: 'v' },
  { id: 'edittext', icon: 'editText', tip: 'Edit existing text (E)', key: 'e' },
  { id: 'text', icon: 'type', tip: 'Add text (T)', key: 't' },
  '-',
  { id: 'draw', icon: 'pen', tip: 'Draw (D)', key: 'd' },
  { id: 'highlight', icon: 'highlighter', tip: 'Highlight (H)', key: 'h' },
  { id: 'whiteout', icon: 'eraser', tip: 'Whiteout (W)', key: 'w' },
  '-',
  { id: 'rect', icon: 'square', tip: 'Rectangle (R)', key: 'r' },
  { id: 'ellipse', icon: 'circle', tip: 'Ellipse (O)', key: 'o' },
  { id: 'line', icon: 'line', tip: 'Line (L)', key: 'l' },
  { id: 'arrow', icon: 'arrow', tip: 'Arrow (A)', key: 'a' },
  '-',
  { id: 'image', icon: 'image', tip: 'Insert image (I)', key: 'i', action: true },
  { id: 'signature', icon: 'signature', tip: 'Add signature (S)', key: 's', action: true },
];
const TOOL_NAMES = { select: 'Select', edittext: 'Edit text', text: 'Text', draw: 'Draw', highlight: 'Highlight', whiteout: 'Whiteout', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow' };
const STICKY_TOOLS = new Set(['draw', 'highlight', 'whiteout', 'edittext']);

const pageEls = new Map();        // page id -> element
const pdfPageCache = new Map();   // "src:index" -> Promise<PDFPageProxy>
const thumbCache = new Map();     // "src:index:rot" -> dataURL
const textItemCache = new Map();  // "src:index:rot" -> items[]
const usedTextItems = new Map();  // page id -> Set(index)
const textSize = new Map();       // annot id -> {w,h}
let clipboard = null;

/* =========================================================================
   DOM refs
   ========================================================================= */
const workspace = $('workspace');
const viewer = $('viewer');
const pagesEl = $('pages');
const thumbsEl = $('thumbs');
const propsBody = $('propsBody');

/* =========================================================================
   Helpers
   ========================================================================= */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = (type === 'success' ? icon('check', 16) : type === 'error' ? icon('info', 16) : '') + `<span>${esc(msg)}</span>`;
  $('toasts').append(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
}

function setLoading(on, text = 'Working…') {
  $('loading').hidden = !on;
  $('loadingText').textContent = text;
}

const getPage = id => S.pages.find(p => p.id === id);
const pageIndex = id => S.pages.findIndex(p => p.id === id);

function srcRotate(p) {
  if (p.src == null) return 0;
  return S.sources[p.src]?.baseRot?.[p.index] || 0;
}
const effRot = p => (srcRotate(p) + p.rotation) % 360;

function dims(p) {
  return p.rotation % 180 ? { dw: p.bh, dh: p.bw } : { dw: p.bw, dh: p.bh };
}

function getPdfPage(p) {
  const key = `${p.src}:${p.index}`;
  if (!pdfPageCache.has(key)) pdfPageCache.set(key, S.sources[p.src].doc.getPage(p.index + 1));
  return pdfPageCache.get(key);
}

function findAnnot(sel = S.sel) {
  if (!sel) return null;
  const p = getPage(sel.pageId);
  return p ? p.annots.find(a => a.id === sel.id) || null : null;
}

/* =========================================================================
   History + autosave
   ========================================================================= */
const hist = { stack: [], idx: -1 };
const snapshot = () => JSON.stringify({ pages: S.pages, settings: S.settings, meta: S.meta });

function commit() {
  hist.stack = hist.stack.slice(0, hist.idx + 1);
  hist.stack.push(snapshot());
  if (hist.stack.length > 120) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
  updateHistoryButtons();
  scheduleSave();
}

function resetHistory() {
  hist.stack = [snapshot()];
  hist.idx = 0;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('undoBtn').disabled = hist.idx <= 0;
  $('redoBtn').disabled = hist.idx >= hist.stack.length - 1;
}

function structureKey() {
  return S.pages.map(p => `${p.id}:${p.rotation}`).join('|');
}

function restore(json) {
  const before = structureKey();
  const data = JSON.parse(json);
  S.pages = data.pages;
  S.settings = data.settings;
  S.meta = data.meta;
  S.sel = null;
  if (structureKey() !== before) rebuildAll();
  else S.pages.forEach(renderAnnots);
  renderProps();
  scheduleSave();
}

function undo() {
  if (S.editing) finishEdit();
  if (hist.idx <= 0) return;
  hist.idx--;
  restore(hist.stack[hist.idx]);
  updateHistoryButtons();
}

function redo() {
  if (hist.idx >= hist.stack.length - 1) return;
  hist.idx++;
  restore(hist.stack[hist.idx]);
  updateHistoryButtons();
}

let saveTimer = null;
function scheduleSave() {
  const st = $('saveState');
  st.classList.add('saving');
  st.innerHTML = `${icon('save', 14)} Saving…`;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSession, 700);
}

async function saveSession() {
  if (!S.pages.length) return;
  await kv.set('session', {
    fileName: S.fileName,
    sources: S.sources.map(s => ({ name: s.name, bytes: s.bytes })),
    data: snapshot(),
  });
  const st = $('saveState');
  st.classList.remove('saving');
  st.innerHTML = `${icon('check', 14)} Saved locally`;
}

/* =========================================================================
   Loading documents
   ========================================================================= */
async function addSource(bytes, name) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const srcIdx = S.sources.length;
  const baseRot = [];
  const sizes = [];
  for (let i = 0; i < doc.numPages; i++) {
    const pg = await doc.getPage(i + 1);
    pdfPageCache.set(`${srcIdx}:${i}`, Promise.resolve(pg));
    const vp = pg.getViewport({ scale: 1 });
    baseRot.push(pg.rotate || 0);
    sizes.push([vp.width, vp.height]);
  }
  S.sources.push({ name, bytes, doc, baseRot });
  return { srcIdx, sizes };
}

function pdfError(err) {
  console.error(err);
  if (err?.name === 'PasswordException') toast('This PDF is password-protected and cannot be opened.', 'error');
  else toast('Could not read this file. Is it a valid PDF?', 'error');
}

async function openPdf(bytes, name) {
  setLoading(true, 'Opening document…');
  try {
    closeDocument(true);
    const { srcIdx, sizes } = await addSource(bytes, name);
    S.pages = sizes.map(([w, h], i) => ({ id: uid(), src: srcIdx, index: i, rotation: 0, bw: w, bh: h, annots: [] }));
    S.fileName = name || 'document.pdf';
    $('fileName').value = S.fileName;
    S.meta.title = S.fileName.replace(/\.pdf$/i, '');
    fitZoom();
    rebuildAll();
    resetHistory();
    scheduleSave();
    toast(`Opened ${S.fileName} · ${S.pages.length} page${S.pages.length > 1 ? 's' : ''}`, 'success');
  } catch (err) {
    closeDocument(true);
    pdfError(err);
  } finally {
    setLoading(false);
  }
}

async function appendPdf(bytes, name) {
  setLoading(true, 'Merging…');
  try {
    const { srcIdx, sizes } = await addSource(bytes, name);
    sizes.forEach(([w, h], i) => S.pages.push({ id: uid(), src: srcIdx, index: i, rotation: 0, bw: w, bh: h, annots: [] }));
    rebuildAll();
    commit();
    toast(`Appended ${sizes.length} page${sizes.length > 1 ? 's' : ''} from ${name}`, 'success');
  } catch (err) {
    pdfError(err);
  } finally {
    setLoading(false);
  }
}

function newBlankDocument() {
  closeDocument(true);
  S.pages = [{ id: uid(), src: null, index: 0, rotation: 0, bw: 595.28, bh: 841.89, annots: [] }];
  S.fileName = 'Untitled.pdf';
  $('fileName').value = S.fileName;
  fitZoom();
  rebuildAll();
  resetHistory();
  scheduleSave();
}

function closeDocument(silent = false) {
  S.sources = [];
  S.pages = [];
  S.sel = null;
  S.editing = null;
  S.settings = { watermark: null, pageNumbers: null };
  S.meta = { title: '', author: '', subject: '', keywords: '' };
  pdfPageCache.clear(); thumbCache.clear(); textItemCache.clear(); usedTextItems.clear(); textSize.clear();
  hist.stack = []; hist.idx = -1;
  updateHistoryButtons();
  rebuildAll();
  if (!silent) {
    kv.del('session');
    $('fileName').value = 'Untitled.pdf';
    toast('Document closed');
  }
}

async function readFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

const isPdf = f => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
const isImage = f => f && /^image\//.test(f.type);

async function handleOpenFile(file) {
  if (!isPdf(file)) return toast('Please choose a PDF file.', 'error');
  if (S.pages.length && hist.idx > 0 && !confirm('Replace the current document? Unsaved edits will be lost.')) return;
  openPdf(await readFile(file), file.name);
}

/* =========================================================================
   Rendering: pages
   ========================================================================= */
const io = new IntersectionObserver(entries => {
  entries.forEach(en => { if (en.isIntersecting) renderCanvas(en.target); });
}, { root: viewer, rootMargin: '800px 0px' });

function rebuildAll() {
  const has = S.pages.length > 0;
  $('empty').hidden = has;
  workspace.classList.toggle('no-doc', !has);
  document.body.classList.toggle('no-doc', !has);
  $('downloadBtn').disabled = !has;
  if (S.sel && !findAnnot()) S.sel = null;
  buildPages();
  buildThumbs();
  renderProps();
  updateCurrent();
}

function buildPages() {
  io.disconnect();
  pageEls.clear();
  pagesEl.innerHTML = '';
  S.pages.forEach((p, i) => {
    const { dw, dh } = dims(p);
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.id = p.id;
    el.innerHTML = `<canvas></canvas><div class="layer tool-${S.tool}"><svg class="svg-layer" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dw} ${dh}"></svg><div class="html-layer"></div></div><div class="page-label">${i + 1} / ${S.pages.length}</div>`;
    sizePage(el, p);
    pagesEl.append(el);
    pageEls.set(p.id, el);
    io.observe(el);
    renderAnnots(p);
    if (S.tool === 'edittext') ensureTextItems(p);
  });
}

function sizePage(el, p) {
  const { dw, dh } = dims(p);
  el.style.width = `${dw * S.zoom}px`;
  el.style.height = `${dh * S.zoom}px`;
  const layer = el.querySelector('.layer');
  layer.style.width = `${dw}px`;
  layer.style.height = `${dh}px`;
  layer.style.transform = `scale(${S.zoom})`;
}

async function renderCanvas(el) {
  const p = getPage(el.dataset.id);
  if (!p || p.src == null) return;
  const rot = effRot(p);
  const key = `${S.zoom}:${rot}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const pg = await getPdfPage(p);
  const vp1 = pg.getViewport({ scale: 1, rotation: rot });
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(S.zoom * dpr, 5000 / Math.max(vp1.width, vp1.height));
  const vp = pg.getViewport({ scale, rotation: rot });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  if (el._task) el._task.cancel();
  const task = pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
  el._task = task;
  try { await task.promise; } catch { return; }
  if (el.dataset.key !== key || !el.isConnected) return;
  canvas.dataset.ready = '1';
  el.querySelector('canvas').replaceWith(canvas);
}

function textStyle(a) {
  return `left:${a.x}px;top:${a.y}px;font-size:${a.size}px;color:${a.color};font-family:${FONT_CSS[a.font] || FONT_CSS.Helvetica};font-weight:${a.bold ? 700 : 400};font-style:${a.italic ? 'italic' : 'normal'};opacity:${a.opacity ?? 1}`;
}

function bbox(a) {
  switch (a.type) {
    case 'text': {
      const s = textSize.get(a.id) || { w: a.size * 0.55 * Math.max(1, ...a.text.split('\n').map(l => l.length)), h: a.size * 1.2 * a.text.split('\n').length };
      return { x: a.x, y: a.y, w: s.w, h: s.h };
    }
    case 'line':
    case 'arrow':
      return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
    case 'draw': {
      const xs = a.points.map(q => q[0]), ys = a.points.map(q => q[1]);
      const r = a.width / 2;
      const x = Math.min(...xs) - r, y = Math.min(...ys) - r;
      return { x, y, w: Math.max(...xs) + r - x, h: Math.max(...ys) + r - y };
    }
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

function renderAnnots(p) {
  const el = pageEls.get(p.id);
  if (!el) return;
  if (S.editing && S.editing.pageId === p.id) syncEditText();
  const { dw, dh } = dims(p);
  const svg = el.querySelector('.svg-layer');
  const html = el.querySelector('.html-layer');
  let s = '';
  let h = '';
  for (const a of p.annots) {
    const op = a.opacity ?? 1;
    switch (a.type) {
      case 'rect':
        s += `<rect data-id="${a.id}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${a.fill || 'none'}" stroke="${a.width > 0 ? a.color : 'none'}" stroke-width="${a.width}" opacity="${op}" pointer-events="all"/>`;
        break;
      case 'ellipse':
        s += `<ellipse data-id="${a.id}" cx="${a.x + a.w / 2}" cy="${a.y + a.h / 2}" rx="${a.w / 2}" ry="${a.h / 2}" fill="${a.fill || 'none'}" stroke="${a.width > 0 ? a.color : 'none'}" stroke-width="${a.width}" opacity="${op}" pointer-events="all"/>`;
        break;
      case 'highlight':
        s += `<rect data-id="${a.id}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${a.color}" opacity="${0.4 * op}" style="mix-blend-mode:multiply" pointer-events="all"/>`;
        break;
      case 'whiteout':
        s += `<rect data-id="${a.id}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${a.fill || '#ffffff'}" opacity="${op}" pointer-events="all"/>`;
        break;
      case 'line':
      case 'arrow':
      case 'draw': {
        let d;
        if (a.type === 'draw') d = 'M' + (a.points.length === 1 ? [a.points[0], a.points[0]] : a.points).map(q => `${q[0]} ${q[1]}`).join('L');
        else {
          d = `M${a.x1} ${a.y1}L${a.x2} ${a.y2}`;
          if (a.type === 'arrow') { const [h1, h2] = arrowHead(a); d += `M${h1[0]} ${h1[1]}L${a.x2} ${a.y2}L${h2[0]} ${h2[1]}`; }
        }
        s += `<g data-id="${a.id}" opacity="${op}"><path d="${d}" fill="none" stroke="${a.color}" stroke-width="${a.width}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(12, a.width + 10)}" pointer-events="stroke"/></g>`;
        break;
      }
      case 'text':
        h += `<div class="a-text" data-id="${a.id}" style="${textStyle(a)}">${esc(a.text)}</div>`;
        break;
      case 'image':
        h += `<img class="a-img" data-id="${a.id}" src="${a.src}" draggable="false" alt="" style="left:${a.x}px;top:${a.y}px;width:${a.w}px;height:${a.h}px;opacity:${op}">`;
        break;
    }
  }

  const wm = S.settings.watermark;
  if (wm?.text) {
    h += `<div class="a-fixed" style="left:${dw / 2}px;top:${dh / 2}px;transform:translate(-50%,-50%) rotate(-45deg);font:700 ${wm.size}px ${FONT_CSS.Helvetica};color:${wm.color};opacity:${wm.opacity}">${esc(wm.text)}</div>`;
  }
  const pn = S.settings.pageNumbers;
  if (pn) {
    const n = pageIndex(p.id) + 1;
    const [vert, horiz] = pn.position.split('-');
    const baseline = vert === 'top' ? 28 + pn.size * 0.8 : dh - 28;
    const top = baseline - 0.846 * pn.size;
    const hpos = horiz === 'left' ? 'left:28px' : horiz === 'right' ? 'right:28px' : `left:${dw / 2}px;transform:translateX(-50%)`;
    h += `<div class="a-fixed" style="${hpos};top:${top}px;font:400 ${pn.size}px ${FONT_CSS.Helvetica};color:${pn.color}">${esc(pageNumberText(pn, n, S.pages.length))}</div>`;
  }

  if (S.tool === 'edittext') {
    const items = textItemCache.get(textKey(p)) || [];
    const used = usedTextItems.get(p.id) || new Set();
    items.forEach((it, i) => {
      if (!used.has(i)) h += `<div class="text-hit" data-i="${i}" title="Click to edit" style="left:${it.x - 1}px;top:${it.y - 1}px;width:${it.w + 2}px;height:${it.h + 2}px"></div>`;
    });
  }

  svg.innerHTML = s;
  html.innerHTML = h;
  html.querySelectorAll('.a-text').forEach(t => textSize.set(t.dataset.id, { w: t.offsetWidth, h: t.offsetHeight }));

  if (S.sel && S.sel.pageId === p.id && !S.editing) {
    const a = findAnnot();
    if (a) {
      const b = bbox(a);
      const z = S.zoom;
      const pad = 3 / z;
      const hs = 10 / z;
      const [hx, hy] = a.type === 'line' || a.type === 'arrow' ? [a.x2, a.y2] : [b.x + b.w + pad, b.y + b.h + pad];
      html.insertAdjacentHTML('beforeend',
        `<div class="sel-box" style="left:${b.x - pad}px;top:${b.y - pad}px;width:${b.w + pad * 2}px;height:${b.h + pad * 2}px;border-width:${1.2 / z}px"></div>` +
        `<div class="sel-h" title="Resize" style="left:${hx}px;top:${hy}px;width:${hs}px;height:${hs}px;border-width:${1.5 / z}px"></div>`);
    }
  }
}

/* =========================================================================
   Thumbnails
   ========================================================================= */
function buildThumbs() {
  $('pageCountLbl').textContent = S.pages.length ? `(${S.pages.length})` : '';
  thumbsEl.innerHTML = S.pages.map((p, i) => {
    const { dw, dh } = dims(p);
    return `<div class="thumb${i === S.current ? ' active' : ''}" draggable="true" data-id="${p.id}">
      <img class="thumb-img" src="${BLANK_PX}" alt="Page ${i + 1}" style="aspect-ratio:${dw}/${dh}">
      <div class="thumb-actions">
        <button data-act="rotl" title="Rotate left">${icon('rotateCcw', 14)}</button>
        <button data-act="rotr" title="Rotate right">${icon('rotateCw', 14)}</button>
        <button data-act="dup" title="Duplicate">${icon('copy', 14)}</button>
        <button data-act="del" class="del" title="Delete">${icon('trash', 14)}</button>
      </div>
      <div class="thumb-num">${i + 1}</div>
    </div>`;
  }).join('');
  S.pages.forEach(p => renderThumb(p).then(url => {
    const img = thumbsEl.querySelector(`[data-id="${p.id}"] img`);
    if (img && url) img.src = url;
  }));
}

async function renderThumb(p) {
  if (p.src == null) return null;
  const rot = effRot(p);
  const key = `${p.src}:${p.index}:${rot}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const pg = await getPdfPage(p);
  const vp1 = pg.getViewport({ scale: 1, rotation: rot });
  const vp = pg.getViewport({ scale: 260 / vp1.width, rotation: rot });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const url = c.toDataURL('image/jpeg', 0.8);
  thumbCache.set(key, url);
  return url;
}

let dragThumbId = null;
thumbsEl.addEventListener('dragstart', e => {
  const t = e.target.closest('.thumb');
  if (!t) return;
  dragThumbId = t.dataset.id;
  t.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragThumbId);
});
thumbsEl.addEventListener('dragend', () => {
  dragThumbId = null;
  thumbsEl.querySelectorAll('.thumb').forEach(t => t.classList.remove('dragging', 'drop-before', 'drop-after'));
});
thumbsEl.addEventListener('dragover', e => {
  if (!dragThumbId) return;
  e.preventDefault();
  e.stopPropagation();
  const t = e.target.closest('.thumb');
  thumbsEl.querySelectorAll('.thumb').forEach(x => x.classList.remove('drop-before', 'drop-after'));
  if (!t || t.dataset.id === dragThumbId) return;
  const r = t.getBoundingClientRect();
  t.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
});
thumbsEl.addEventListener('drop', e => {
  if (!dragThumbId) return;
  e.preventDefault();
  e.stopPropagation();
  const t = e.target.closest('.thumb');
  if (!t || t.dataset.id === dragThumbId) return;
  const after = t.classList.contains('drop-after');
  const from = pageIndex(dragThumbId);
  const [moved] = S.pages.splice(from, 1);
  let to = pageIndex(t.dataset.id) + (after ? 1 : 0);
  S.pages.splice(to, 0, moved);
  S.current = to;
  rebuildAll();
  commit();
  scrollToPage(to);
});
thumbsEl.addEventListener('click', e => {
  const t = e.target.closest('.thumb');
  if (!t) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  const id = t.dataset.id;
  if (act === 'rotl') rotatePage(id, -90);
  else if (act === 'rotr') rotatePage(id, 90);
  else if (act === 'dup') duplicatePage(id);
  else if (act === 'del') deletePage(id);
  else {
    scrollToPage(pageIndex(id));
    if (matchMedia('(max-width: 900px)').matches) $('sidebar').classList.remove('open');
  }
});

/* =========================================================================
   Page operations
   ========================================================================= */
function rotatePage(id, delta) {
  const p = getPage(id);
  const { dw, dh } = dims(p);
  const cw = delta > 0;
  const tp = (x, y) => (cw ? [dh - y, x] : [y, dw - x]);
  const rotBox = (x, y, w, h) => {
    const [ax, ay] = tp(x, y);
    const [bx, by] = tp(x + w, y + h);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  };
  for (const a of p.annots) {
    if (a.type === 'line' || a.type === 'arrow') {
      [a.x1, a.y1] = tp(a.x1, a.y1);
      [a.x2, a.y2] = tp(a.x2, a.y2);
    } else if (a.type === 'draw') {
      a.points = a.points.map(q => tp(q[0], q[1]));
    } else if (a.type === 'text' || a.type === 'image') {
      const b = bbox(a);
      const [cx, cy] = tp(b.x + b.w / 2, b.y + b.h / 2);
      a.x = cx - b.w / 2;
      a.y = cy - b.h / 2;
    } else {
      Object.assign(a, rotBox(a.x, a.y, a.w, a.h));
    }
  }
  p.rotation = (p.rotation + delta + 360) % 360;
  usedTextItems.delete(p.id);
  rebuildAll();
  commit();
}

function duplicatePage(id) {
  const i = pageIndex(id);
  const copy = clone(S.pages[i]);
  copy.id = uid();
  copy.annots.forEach(a => (a.id = uid()));
  S.pages.splice(i + 1, 0, copy);
  rebuildAll();
  commit();
  toast(`Page ${i + 1} duplicated`);
}

function deletePage(id) {
  if (S.pages.length === 1) return toast('A document needs at least one page.', 'error');
  const i = pageIndex(id);
  S.pages.splice(i, 1);
  S.current = Math.min(S.current, S.pages.length - 1);
  rebuildAll();
  commit();
  toast(`Page ${i + 1} deleted — press Ctrl+Z to undo`);
}

function insertBlankPage() {
  if (!S.pages.length) return newBlankDocument();
  const ref = S.pages[S.current] || S.pages[0];
  const { dw, dh } = dims(ref);
  S.pages.splice(S.current + 1, 0, { id: uid(), src: null, index: 0, rotation: 0, bw: dw, bh: dh, annots: [] });
  S.current++;
  rebuildAll();
  commit();
  scrollToPage(S.current);
}

/* =========================================================================
   Zoom + navigation
   ========================================================================= */
function setZoom(z) {
  z = clamp(Math.round(z * 100) / 100, 0.25, 4);
  if (z === S.zoom) return;
  const ratioY = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  const ratioX = viewer.scrollLeft / Math.max(1, viewer.scrollWidth);
  S.zoom = z;
  $('zoomVal').textContent = `${Math.round(z * 100)}%`;
  S.pages.forEach(p => {
    const el = pageEls.get(p.id);
    if (!el) return;
    sizePage(el, p);
    renderAnnots(p);
    io.unobserve(el);
    io.observe(el);
  });
  viewer.scrollTop = ratioY * viewer.scrollHeight;
  viewer.scrollLeft = ratioX * viewer.scrollWidth;
}

function fitZoom(apply = false) {
  const maxW = Math.max(...S.pages.map(p => dims(p).dw), 1);
  const avail = viewer.clientWidth - (innerWidth < 900 ? 28 : 80);
  const z = clamp(Math.floor((avail / maxW) * 100) / 100, 0.25, apply ? 4 : 1.5);
  if (apply) setZoom(z);
  else { S.zoom = z; $('zoomVal').textContent = `${Math.round(z * 100)}%`; }
}

function scrollToPage(i) {
  const p = S.pages[i];
  const el = p && pageEls.get(p.id);
  if (el) viewer.scrollTo({ top: el.offsetTop - 20, behavior: 'smooth' });
}

function updateCurrent() {
  if (!S.pages.length) { $('pageInd').textContent = '–'; return; }
  const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 3;
  let best = 0, bestD = Infinity;
  S.pages.forEach((p, i) => {
    const r = pageEls.get(p.id)?.getBoundingClientRect();
    if (!r) return;
    const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
    if (d < bestD) { bestD = d; best = i; }
  });
  S.current = best;
  $('pageInd').textContent = `${best + 1} / ${S.pages.length}`;
  pageEls.forEach((el, id) => el.classList.toggle('current', S.pages.length > 1 && id === S.pages[best].id));
  thumbsEl.querySelectorAll('.thumb').forEach((t, i) => t.classList.toggle('active', i === best));
}

let scrollRaf = 0;
viewer.addEventListener('scroll', () => {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(updateCurrent);
}, { passive: true });

viewer.addEventListener('wheel', e => {
  if (!e.ctrlKey || !S.pages.length) return;
  e.preventDefault();
  setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

/* =========================================================================
   Tools
   ========================================================================= */
function buildToolrail() {
  $('toolrail').innerHTML = TOOLS.map(t => t === '-' ? '<span class="sep"></span>' :
    `<button class="tool-btn${S.tool === t.id ? ' active' : ''}" data-tool="${t.id}" data-tip="${t.tip}" aria-label="${t.tip}">${icon(t.icon, 20)}</button>`).join('');
}

function setTool(tool) {
  const def = TOOLS.find(t => t.id === tool);
  if (!def) return;
  if (!S.pages.length) return toast('Open a PDF first.', 'error');
  if (def.action) {
    if (tool === 'image') $('imageInput').click();
    else openSignatureModal();
    return;
  }
  if (S.editing) finishEdit();
  const prev = S.tool;
  S.tool = tool;
  if (tool !== 'select') S.sel = null;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  document.querySelectorAll('.layer').forEach(l => (l.className = `layer tool-${tool}`));
  if (tool === 'edittext') {
    S.pages.forEach(ensureTextItems);
    toast('Click any highlighted text to edit it');
  }
  if (prev === 'edittext' || tool === 'edittext' || prev === 'select') S.pages.forEach(renderAnnots);
  renderProps();
}

$('toolrail').addEventListener('click', e => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});

/* ----- Edit existing text ----- */
const textKey = p => `${p.src}:${p.index}:${effRot(p)}`;

async function ensureTextItems(p) {
  if (p.src == null) return;
  const key = textKey(p);
  if (!textItemCache.has(key)) {
    const pg = await getPdfPage(p);
    const rot = effRot(p);
    const vp = pg.getViewport({ scale: 1, rotation: rot });
    const tc = await pg.getTextContent();
    // Loading the operator list makes the page's font objects (real names, bold/italic flags) available
    try { await pg.getOperatorList(); } catch {}
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01 || tx[0] <= 0) continue;
      const size = Math.abs(tx[3]) || Math.hypot(tx[2], tx[3]);
      if (size < 2) continue;
      let fontObj = null;
      try { if (pg.commonObjs.has(it.fontName)) fontObj = pg.commonObjs.get(it.fontName); } catch {}
      const f = describeFont(fontObj, tc.styles[it.fontName]);
      const w = it.width || size * it.str.length * 0.5;
      const item = { x: tx[4], y: tx[5] - size * 0.9, w, h: size * 1.15, size, str: it.str, baseline: tx[5], ...f };
      // PDFs often split one line into several runs; join adjacent runs with the same style
      const prev = items[items.length - 1];
      const gap = prev ? item.x - (prev.x + prev.w) : Infinity;
      if (prev && Math.abs(prev.baseline - item.baseline) < 0.5 && Math.abs(prev.size - item.size) < 0.3 &&
          prev.font === item.font && prev.bold === item.bold && prev.italic === item.italic && gap > -1 && gap < item.size * 0.8) {
        const space = gap > item.size * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(item.str) ? ' ' : '';
        prev.str += space + item.str;
        prev.w = item.x + item.w - prev.x;
      } else {
        items.push(item);
      }
    }
    textItemCache.set(key, items);
  }
  if (S.tool === 'edittext') renderAnnots(p);
}

// Map a PDF font (e.g. "ABCDEF+Arial-BoldMT") to the closest standard font + weight/style
function describeFont(obj, styleInfo) {
  const raw = String(obj?.name || '').replace(/^[A-Z]{6}\+/, '');
  const n = raw.toLowerCase();
  const fam = String(styleInfo?.fontFamily || '').toLowerCase();
  const bold = !!(obj?.bold || obj?.black) || /bold|black|heavy|semibold|demi|extrabold|ultra/.test(n);
  const italic = !!obj?.italic || /italic|oblique|-it\b|kursiv/.test(n);
  const sansName = /sans|arial|helvet|calibri|verdana|segoe|roboto|open|lato|tahoma|trebuchet|futura|gill|myriad|frutiger|avenir|inter|noto ?sans|source ?sans|montserrat|poppins/.test(n);
  let family = 'Helvetica';
  if (/courier|mono|consol|menlo|inconsolata|lucida ?console|code/.test(n) || fam.includes('monospace')) family = 'Courier';
  else if (!sansName && (/times|georgia|garamond|cambria|palatino|bookman|antiqua|minion|baskerville|caslon|century|didot|bodoni|serif|tnr|charter|merriweather|playfair/.test(n) || (fam.includes('serif') && !fam.includes('sans')))) family = 'Times';
  return { font: family, bold, italic, origFont: raw };
}

const toHex = (r, g, b) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

// Bitmap of the page as displayed: reuse the on-screen render, otherwise render offscreen
async function pageBitmap(p) {
  const c = pageEls.get(p.id)?.querySelector('canvas');
  if (c?.dataset.ready) return c;
  if (p.src == null) return null;
  const pg = await getPdfPage(p);
  const { dw } = dims(p);
  const vp = pg.getViewport({ scale: 2, rotation: effRot(p) });
  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width);
  off.height = Math.floor(vp.height);
  await pg.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
  return off.width && dw ? off : null;
}

// Find the background and ink colors inside a text box by sampling rendered pixels
async function sampleTextColors(p, it) {
  try {
    const c = await pageBitmap(p);
    if (!c) return null;
    const k = c.width / dims(p).dw;
    const x0 = clamp(Math.floor(it.x * k), 0, c.width - 1), y0 = clamp(Math.floor(it.y * k), 0, c.height - 1);
    const w = Math.min(c.width - x0, Math.ceil(it.w * k)), h = Math.min(c.height - y0, Math.ceil(it.h * k));
    if (w < 1 || h < 1) return null;
    const d = c.getContext('2d').getImageData(x0, y0, w, h).data;
    // Background = most common (quantized) color
    const buckets = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      const b = buckets.get(key) || [0, 0, 0, 0];
      b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++;
      buckets.set(key, b);
    }
    let best = null;
    buckets.forEach(b => { if (!best || b[3] > best[3]) best = b; });
    const bg = best ? [best[0] / best[3], best[1] / best[3], best[2] / best[3]] : [255, 255, 255];
    // Ink = the pixels furthest from the background (anti-aliased edges are ignored)
    const ink = [];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const dist = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
      if (dist > 90) ink.push([dist, d[i], d[i + 1], d[i + 2]]);
    }
    let inkHex = null;
    if (ink.length) {
      ink.sort((a, b) => b[0] - a[0]);
      const top = ink.slice(0, Math.max(1, Math.ceil(ink.length * 0.3)));
      const avg = [1, 2, 3].map(j => top.reduce((s, q) => s + q[j], 0) / top.length);
      inkHex = Math.max(...avg) < 40 ? '#000000' : toHex(...avg);
    }
    const bgHex = Math.min(...bg) > 245 ? '#ffffff' : toHex(...bg);
    return { bg: bgHex, ink: inkHex };
  } catch (err) {
    console.warn('Color sampling failed', err);
    return null;
  }
}

async function editExistingText(p, i) {
  const it = textItemCache.get(textKey(p))?.[i];
  if (!it) return;
  if (!usedTextItems.has(p.id)) usedTextItems.set(p.id, new Set());
  if (usedTextItems.get(p.id).has(i)) return;
  usedTextItems.get(p.id).add(i);
  const colors = await sampleTextColors(p, it);
  const size = Math.round(it.size * 10) / 10;
  p.annots.push({ id: uid(), type: 'whiteout', x: it.x - 1, y: it.y - 1, w: it.w + 2, h: it.h + 2, fill: colors?.bg || '#ffffff', opacity: 1 });
  const t = { id: uid(), type: 'text', x: it.x, y: it.baseline - (FONT_BASELINE[it.font] || 0.945) * size, text: it.str, size, font: it.font, bold: it.bold, italic: it.italic, color: colors?.ink || '#000000', opacity: 1, origFont: it.origFont };
  p.annots.push(t);
  S.sel = { pageId: p.id, id: t.id };
  renderAnnots(p);
  renderProps();
  setTimeout(() => startEdit(p, t, true));
}

/* ----- Text editing ----- */
function startEdit(p, a, selectAll = false) {
  const el = pageEls.get(p.id)?.querySelector(`.a-text[data-id="${a.id}"]`);
  if (!el) return;
  S.editing = { pageId: p.id, id: a.id };
  S.sel = { pageId: p.id, id: a.id };
  pageEls.get(p.id).querySelectorAll('.sel-box,.sel-h').forEach(x => x.remove());
  try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
  el.classList.add('editing');
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  if (!selectAll) range.collapse(false);
  const selObj = getSelection();
  selObj.removeAllRanges();
  selObj.addRange(range);
}

function syncEditText() {
  const ed = S.editing;
  if (!ed) return;
  const p = getPage(ed.pageId);
  const a = p?.annots.find(x => x.id === ed.id);
  const el = pageEls.get(ed.pageId)?.querySelector(`.a-text[data-id="${ed.id}"]`);
  if (a && el) a.text = el.innerText.replace(/\n$/, '').replace(/ /g, ' ');
  S.editing = null;
}

function finishEdit() {
  const ed = S.editing;
  if (!ed) return;
  syncEditText();
  const p = getPage(ed.pageId);
  if (!p) return;
  const a = p.annots.find(x => x.id === ed.id);
  if (a && !a.text.trim()) {
    p.annots = p.annots.filter(x => x !== a);
    if (S.sel?.id === a.id) S.sel = null;
  }
  renderAnnots(p);
  renderProps();
  commit();
}

/* =========================================================================
   Pointer interaction
   ========================================================================= */
let drag = null;

function toPt(e, layer) {
  const r = layer.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
}

function select(p, id) {
  const prev = S.sel?.pageId;
  S.sel = id ? { pageId: p.id, id } : null;
  if (prev && prev !== p?.id) { const pp = getPage(prev); if (pp) renderAnnots(pp); }
  if (p) renderAnnots(p);
  renderProps();
}

function deselect() {
  if (!S.sel) return;
  const p = getPage(S.sel.pageId);
  S.sel = null;
  if (p) renderAnnots(p);
  renderProps();
}

pagesEl.addEventListener('pointerdown', e => {
  const layer = e.target.closest('.layer');
  if (!layer || e.button > 0) return;
  const p = getPage(layer.parentElement.dataset.id);
  if (!p) return;
  closeDrawers();
  const editingEl = e.target.closest('.a-text.editing');
  if (editingEl) return;
  if (S.editing) finishEdit();
  const pt = toPt(e, layer);
  const tool = S.tool;

  if (tool === 'select') {
    const handle = e.target.closest('.sel-h');
    const target = e.target.closest('[data-id]');
    if (handle && S.sel?.pageId === p.id) {
      const a = findAnnot();
      drag = { mode: 'resize', p, a, layer, start: pt, orig: clone(a), box: bbox(a) };
    } else if (target) {
      const id = target.dataset.id;
      if (S.sel?.id !== id) select(p, id);
      const a = findAnnot();
      drag = { mode: 'move', p, a, layer, start: pt, orig: clone(a), moved: false };
    } else {
      deselect();
      return;
    }
    layer.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  if (tool === 'edittext') {
    const hit = e.target.closest('.text-hit');
    const own = e.target.closest('.a-text[data-id]');
    if (hit) { e.preventDefault(); editExistingText(p, Number(hit.dataset.i)); }
    else if (own) { e.preventDefault(); const oa = p.annots.find(x => x.id === own.dataset.id); setTimeout(() => startEdit(p, oa)); }
    return;
  }

  e.preventDefault();
  const base = { id: uid(), opacity: style.opacity };
  let a;
  switch (tool) {
    case 'text': {
      const existing = e.target.closest('.a-text[data-id]');
      if (existing) {
        const ea = p.annots.find(x => x.id === existing.dataset.id);
        setTool('select');
        setTimeout(() => startEdit(p, ea));
        return;
      }
      a = { ...base, type: 'text', x: pt.x, y: pt.y - style.size * 0.6, text: '', size: style.size, font: style.font, bold: style.bold, italic: style.italic, color: style.color };
      p.annots.push(a);
      setTool('select');
      S.sel = { pageId: p.id, id: a.id };
      renderAnnots(p);
      renderProps();
      setTimeout(() => startEdit(p, a));
      return;
    }
    case 'draw':
      a = { ...base, type: 'draw', points: [[pt.x, pt.y]], color: style.color, width: style.width };
      break;
    case 'line':
    case 'arrow':
      a = { ...base, type: tool, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, color: style.color, width: style.width };
      break;
    case 'rect':
    case 'ellipse':
      a = { ...base, type: tool, x: pt.x, y: pt.y, w: 0, h: 0, color: style.color, fill: style.fill, width: style.width };
      break;
    case 'highlight':
      a = { ...base, type: 'highlight', x: pt.x, y: pt.y, w: 0, h: 0, color: style.hl };
      break;
    case 'whiteout':
      a = { ...base, type: 'whiteout', x: pt.x, y: pt.y, w: 0, h: 0, fill: style.wo };
      break;
    default:
      return;
  }
  p.annots.push(a);
  drag = { mode: 'create', p, a, layer, start: pt };
  layer.setPointerCapture(e.pointerId);
  renderAnnots(p);
});

let moveRaf = 0;
pagesEl.addEventListener('pointermove', e => {
  if (!drag) return;
  const pt = toPt(e, drag.layer);
  const { a, start, orig } = drag;
  const dx = pt.x - start.x, dy = pt.y - start.y;

  if (drag.mode === 'move') {
    if (!drag.moved && Math.hypot(dx, dy) * S.zoom < 3) return;
    drag.moved = true;
    moveAnnot(a, orig, dx, dy);
  } else if (drag.mode === 'resize') {
    resizeAnnot(a, orig, drag.box, dx, dy, e.shiftKey);
  } else if (drag.mode === 'create') {
    if (a.type === 'draw') {
      const last = a.points[a.points.length - 1];
      if (Math.hypot(pt.x - last[0], pt.y - last[1]) > 1 / S.zoom) a.points.push([Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10]);
    } else if (a.type === 'line' || a.type === 'arrow') {
      let x2 = pt.x, y2 = pt.y;
      if (e.shiftKey) {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x2 = start.x + len * Math.cos(ang);
        y2 = start.y + len * Math.sin(ang);
      }
      a.x2 = x2; a.y2 = y2;
    } else {
      let w = dx, h = dy;
      if (e.shiftKey && a.type !== 'highlight') { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      a.x = Math.min(start.x, start.x + w); a.y = Math.min(start.y, start.y + h);
      a.w = Math.abs(w); a.h = Math.abs(h);
    }
  }
  cancelAnimationFrame(moveRaf);
  const p = drag.p;
  moveRaf = requestAnimationFrame(() => renderAnnots(p));
});

function endDrag() {
  if (!drag) return;
  const { p, a, mode, moved } = drag;
  drag = null;
  cancelAnimationFrame(moveRaf);
  if (mode === 'create') {
    const tiny = a.type === 'draw' ? false : a.type === 'line' || a.type === 'arrow' ? Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3 : a.w < 3 && a.h < 3;
    if (tiny) {
      if (a.type === 'rect' || a.type === 'ellipse' || a.type === 'whiteout') { a.w = 120; a.h = 70; }
      else if (a.type === 'line' || a.type === 'arrow') { a.x2 = a.x1 + 120; }
      else { p.annots = p.annots.filter(x => x !== a); renderAnnots(p); return; }
    }
    if (!STICKY_TOOLS.has(S.tool)) {
      setTool('select');
      S.sel = { pageId: p.id, id: a.id };
    }
    renderAnnots(p);
    renderProps();
    commit();
  } else if (mode === 'move') {
    if (moved) { renderAnnots(p); commit(); }
  } else {
    renderAnnots(p);
    commit();
  }
}
pagesEl.addEventListener('pointerup', () => endDrag());
pagesEl.addEventListener('pointercancel', () => endDrag());

pagesEl.addEventListener('dblclick', e => {
  const t = e.target.closest('.a-text[data-id]');
  if (!t || S.tool !== 'select') return;
  const p = getPage(t.closest('.page').dataset.id);
  const a = p.annots.find(x => x.id === t.dataset.id);
  if (a) startEdit(p, a);
});

function moveAnnot(a, o, dx, dy) {
  if (a.type === 'line' || a.type === 'arrow') {
    a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy;
  } else if (a.type === 'draw') {
    a.points = o.points.map(q => [q[0] + dx, q[1] + dy]);
  } else {
    a.x = o.x + dx; a.y = o.y + dy;
  }
}

function resizeAnnot(a, o, box, dx, dy, shift) {
  switch (a.type) {
    case 'line':
    case 'arrow':
      a.x2 = o.x2 + dx; a.y2 = o.y2 + dy;
      break;
    case 'text': {
      const f = Math.max(0.1, (box.h + dy) / box.h);
      a.size = clamp(Math.round(o.size * f * 2) / 2, 4, 400);
      break;
    }
    case 'draw': {
      const fx = Math.max(0.05, (box.w + dx) / box.w), fy = Math.max(0.05, (box.h + dy) / box.h);
      a.points = o.points.map(q => [box.x + (q[0] - box.x) * fx, box.y + (q[1] - box.y) * fy]);
      break;
    }
    case 'image': {
      const w = Math.max(10, o.w + dx);
      a.w = w;
      a.h = shift ? Math.max(10, o.h + dy) : w * (o.h / o.w);
      break;
    }
    default:
      a.w = Math.max(4, o.w + dx);
      a.h = Math.max(4, o.h + dy);
      if (shift) a.h = a.w;
  }
}

/* =========================================================================
   Annotation operations
   ========================================================================= */
function deleteSelected() {
  const a = findAnnot();
  if (!a) return;
  const p = getPage(S.sel.pageId);
  p.annots = p.annots.filter(x => x !== a);
  S.sel = null;
  renderAnnots(p);
  renderProps();
  commit();
}

function duplicateSelected() {
  const a = findAnnot();
  if (!a) return;
  const p = getPage(S.sel.pageId);
  const c = clone(a);
  c.id = uid();
  moveAnnot(c, clone(a), 14, 14);
  p.annots.push(c);
  select(p, c.id);
  commit();
}

function pasteClipboard() {
  if (!clipboard || !S.pages.length) return;
  const p = S.pages[S.current];
  const c = clone(clipboard);
  c.id = uid();
  moveAnnot(c, clone(clipboard), 14, 14);
  clipboard = clone(c);
  p.annots.push(c);
  select(p, c.id);
  commit();
}

function arrange(dir) {
  const a = findAnnot();
  if (!a) return;
  const p = getPage(S.sel.pageId);
  p.annots = p.annots.filter(x => x !== a);
  dir === 'front' ? p.annots.push(a) : p.annots.unshift(a);
  renderAnnots(p);
  commit();
}

function insertImageAnnot(src, natW, natH, { maxW = 0.5, label = 'Image' } = {}) {
  const p = S.pages[S.current] || S.pages[0];
  const { dw, dh } = dims(p);
  let w = Math.min(natW, dw * maxW);
  let h = w * (natH / natW);
  if (h > dh * 0.6) { h = dh * 0.6; w = h * (natW / natH); }
  // Center in the visible part of the page
  let cx = dw / 2, cy = dh / 2;
  const pr = pageEls.get(p.id)?.getBoundingClientRect();
  const vr = viewer.getBoundingClientRect();
  if (pr) {
    const top = Math.max(pr.top, vr.top), bottom = Math.min(pr.bottom, vr.bottom);
    if (bottom > top) cy = ((top + bottom) / 2 - pr.top) / S.zoom;
  }
  const a = { id: uid(), type: 'image', src, x: clamp(cx - w / 2, 0, dw - w), y: clamp(cy - h / 2, 0, dh - h), w, h, opacity: 1 };
  p.annots.push(a);
  setTool('select');
  select(p, a.id);
  commit();
  toast(`${label} added — drag to position, use the corner to resize`);
}

function loadImage(src) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src; });
}

async function insertImageFile(file) {
  if (!S.pages.length) return toast('Open a PDF first.', 'error');
  const reader = new FileReader();
  const dataUrl = await new Promise(r => { reader.onload = () => r(reader.result); reader.readAsDataURL(file); });
  let img;
  try { img = await loadImage(dataUrl); } catch { return toast('Unsupported image.', 'error'); }
  let src = dataUrl;
  if (!/^data:image\/(png|jpeg)/.test(dataUrl)) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    src = c.toDataURL('image/png');
  }
  insertImageAnnot(src, img.naturalWidth, img.naturalHeight);
}

/* =========================================================================
   Properties panel
   ========================================================================= */
const FIELDS = {
  text: ['color', 'font', 'size', 'opacity'],
  rect: ['color', 'fill', 'width', 'opacity'],
  ellipse: ['color', 'fill', 'width', 'opacity'],
  line: ['color', 'width', 'opacity'],
  arrow: ['color', 'width', 'opacity'],
  draw: ['color', 'width', 'opacity'],
  highlight: ['hl', 'opacity'],
  whiteout: ['wo'],
  image: ['opacity'],
};
const ANNOT_LABEL = { text: 'Text', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', draw: 'Drawing', highlight: 'Highlight', whiteout: 'Whiteout', image: 'Image' };

function val(key, a) {
  if (a) {
    if (key === 'hl') return a.color;
    if (key === 'wo') return a.fill;
    return a[key] ?? style[key];
  }
  return style[key];
}

function swatches(key, colors, cur, allowNone = false) {
  return `<div class="swatches">${allowNone ? `<button class="swatch none${cur === 'none' ? ' on' : ''}" data-set="${key}" data-val="none" title="No fill"></button>` : ''}${colors.map(c => `<button class="swatch${c.toLowerCase() === String(cur).toLowerCase() ? ' on' : ''}" style="background:${c}" data-set="${key}" data-val="${c}" title="${c}"></button>`).join('')}<input type="color" class="color-input" data-color="${key}" value="${cur && cur !== 'none' ? cur : '#000000'}" title="Custom color"></div>`;
}

function fieldHtml(key, a) {
  const v = val(key, a);
  switch (key) {
    case 'color': return `<div class="field"><label>${a?.type === 'text' || (!a && S.tool === 'text') ? 'Text color' : 'Stroke color'}</label>${swatches('color', COLORS, v)}</div>`;
    case 'fill': return `<div class="field"><label>Fill</label>${swatches('fill', COLORS, v, true)}</div>`;
    case 'hl': return `<div class="field"><label>Highlight color</label>${swatches('hl', HL_COLORS, v)}</div>`;
    case 'wo': return `<div class="field"><label>Cover color</label>${swatches('wo', ['#ffffff', '#f8fafc', '#f5f5dc', '#000000'], v)}</div>`;
    case 'width': return `<div class="field"><label>Stroke width</label><div class="field-row"><input type="range" min="0" max="24" step="0.5" value="${v}" data-range="width"><span class="range-val">${v}pt</span></div></div>`;
    case 'opacity': return `<div class="field"><label>Opacity</label><div class="field-row"><input type="range" min="0.05" max="1" step="0.05" value="${v}" data-range="opacity"><span class="range-val">${Math.round(v * 100)}%</span></div></div>`;
    case 'size': return `<div class="field"><label>Font size</label><div class="field-row"><input type="range" min="6" max="96" step="0.5" value="${v}" data-range="size"><input class="input" style="width:64px" type="number" min="4" max="400" step="0.5" value="${v}" data-num="size"></div></div>`;
    case 'font': {
      const bold = val('bold', a), italic = val('italic', a);
      return `<div class="field"><label>Font</label><div class="field-row"><select class="select" data-select="font">${Object.keys(FONT_CSS).map(f => `<option value="${f}"${f === v ? ' selected' : ''}>${f === 'Times' ? 'Times New Roman' : f}</option>`).join('')}</select>
        <div class="seg"><button data-toggle="bold" class="${bold ? 'on' : ''}" title="Bold">${icon('bold', 16)}</button><button data-toggle="italic" class="${italic ? 'on' : ''}" title="Italic">${icon('italic', 16)}</button></div></div></div>`;
    }
  }
  return '';
}

function renderProps() {
  const a = S.tool === 'select' ? findAnnot() : null;
  const title = $('propsTitle');
  let html = '';
  if (!S.pages.length) { propsBody.innerHTML = ''; return; }

  if (a) {
    title.textContent = ANNOT_LABEL[a.type] || 'Properties';
    html += FIELDS[a.type].map(k => fieldHtml(k, a)).join('');
    if (a.type === 'text' && a.origFont) {
      const matched = `${a.font === 'Times' ? 'Times New Roman' : a.font}${a.bold ? ' Bold' : ''}${a.italic ? ' Italic' : ''}`;
      html += `<div class="props-note">Original font: <b>${esc(a.origFont)}</b><br>Matched to: <b>${matched}</b></div>`;
    }
    html += `<div class="props-actions">
      ${a.type === 'text' ? `<button class="btn btn-sm" data-do="edit">${icon('type', 15)} Edit text</button>` : ''}
      <button class="btn btn-sm" data-do="dup">${icon('copy', 15)} Duplicate</button>
      <button class="btn btn-sm" data-do="front">${icon('layers', 15)} To front</button>
      <button class="btn btn-sm" data-do="back">${icon('layers', 15)} To back</button>
      <button class="btn btn-sm btn-danger" data-do="del">${icon('trash', 15)} Delete</button>
    </div>`;
  } else if (FIELDS[S.tool]) {
    title.textContent = `${TOOL_NAMES[S.tool]} tool`;
    html += FIELDS[S.tool].map(k => fieldHtml(k, null)).join('');
    html += `<div class="props-note">${toolHint(S.tool)}</div>`;
  } else if (S.tool === 'edittext') {
    title.textContent = 'Edit text';
    html += `<div class="props-note"><b>Click any outlined text</b> on the page to replace it. The original is covered with a whiteout and an editable copy is placed on top with a matching size.<br><br>Press <b>Esc</b> or click elsewhere to finish. Clear the text to remove it entirely.</div>`;
  } else {
    title.textContent = 'Document';
    const p = S.pages[S.current];
    const { dw, dh } = p ? dims(p) : { dw: 0, dh: 0 };
    const annCount = S.pages.reduce((n, x) => n + x.annots.length, 0);
    const bytes = S.sources.reduce((n, s) => n + s.bytes.length, 0);
    html += `<div class="kv">
      <span>File</span><span title="${esc(S.fileName)}">${esc(S.fileName)}</span>
      <span>Pages</span><span>${S.pages.length}</span>
      <span>Source size</span><span>${bytes ? (bytes / 1024 / 1024).toFixed(2) + ' MB' : '—'}</span>
      <span>Edits</span><span>${annCount}</span>
      <span>Page size</span><span>${Math.round(dw)} × ${Math.round(dh)} pt</span>
    </div>
    <div class="field"><span class="field-label">Current page (${S.current + 1})</span>
      <div class="props-actions">
        <button class="btn btn-sm" data-do="protl">${icon('rotateCcw', 15)} Rotate</button>
        <button class="btn btn-sm" data-do="protr">${icon('rotateCw', 15)} Rotate</button>
        <button class="btn btn-sm" data-do="pdup">${icon('copy', 15)} Duplicate</button>
        <button class="btn btn-sm btn-danger" data-do="pdel">${icon('trash', 15)} Delete</button>
      </div>
    </div>
    <div class="field"><span class="field-label">Document</span>
      <div class="props-actions">
        <button class="btn btn-sm" data-do="watermark">${icon('droplet', 15)} Watermark</button>
        <button class="btn btn-sm" data-do="pageNumbers">${icon('hash', 15)} Numbers</button>
        <button class="btn btn-sm" data-do="extract">${icon('scissors', 15)} Extract</button>
        <button class="btn btn-sm" data-do="merge">${icon('layers', 15)} Merge</button>
      </div>
    </div>
    <div class="props-note"><b>Tip:</b> pick a tool on the left and click on a page. Double-click text to edit it; drag the corner handle to resize.</div>`;
  }
  propsBody.innerHTML = html;
}

function toolHint(tool) {
  return {
    text: '<b>Click</b> anywhere on a page to add text. Press <b>Esc</b> when done.',
    draw: '<b>Drag</b> to draw freehand. The tool stays active until you pick another.',
    highlight: '<b>Drag</b> over content to highlight it.',
    whiteout: '<b>Drag</b> to cover content. Combine with Text to replace it.',
    rect: '<b>Drag</b> to draw. Hold <b>Shift</b> for a square.',
    ellipse: '<b>Drag</b> to draw. Hold <b>Shift</b> for a circle.',
    line: '<b>Drag</b> to draw. Hold <b>Shift</b> to snap to 45°.',
    arrow: '<b>Drag</b> to draw. Hold <b>Shift</b> to snap to 45°.',
  }[tool] || '';
}

function applyProp(key, value, doCommit) {
  const sk = key;
  style[sk] = value;
  const a = S.tool === 'select' ? findAnnot() : null;
  if (a) {
    const ak = key === 'hl' ? 'color' : key === 'wo' ? 'fill' : key;
    a[ak] = value;
    const p = getPage(S.sel.pageId);
    if (S.editing?.id === a.id) {
      const el = pageEls.get(p.id).querySelector(`.a-text[data-id="${a.id}"]`);
      el.style.cssText = textStyle(a);
    } else renderAnnots(p);
    if (doCommit) commit();
  }
}

propsBody.addEventListener('mousedown', e => { if (S.editing && e.target.closest('button')) e.preventDefault(); });
propsBody.addEventListener('click', e => {
  const set = e.target.closest('[data-set]');
  if (set) { applyProp(set.dataset.set, set.dataset.val, true); renderProps(); return; }
  const tog = e.target.closest('[data-toggle]');
  if (tog) { const k = tog.dataset.toggle; applyProp(k, !val(k, S.tool === 'select' ? findAnnot() : null), true); renderProps(); return; }
  const act = e.target.closest('[data-do]')?.dataset.do;
  if (!act) return;
  const curId = S.pages[S.current]?.id;
  ({
    edit: () => { const a = findAnnot(); startEdit(getPage(S.sel.pageId), a, true); },
    dup: duplicateSelected, del: deleteSelected,
    front: () => arrange('front'), back: () => arrange('back'),
    protl: () => rotatePage(curId, -90), protr: () => rotatePage(curId, 90),
    pdup: () => duplicatePage(curId), pdel: () => deletePage(curId),
    watermark: openWatermarkModal, pageNumbers: openPageNumbersModal, extract: openExtractModal, merge: () => $('mergeInput').click(),
  })[act]?.();
});
propsBody.addEventListener('input', e => {
  const r = e.target.dataset.range || e.target.dataset.num;
  if (r) {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    applyProp(r, v, false);
    const lbl = e.target.parentElement.querySelector('.range-val');
    if (lbl) lbl.textContent = r === 'opacity' ? `${Math.round(v * 100)}%` : `${v}pt`;
    const twin = e.target.parentElement.querySelector(e.target.dataset.range ? '[data-num]' : '[data-range]');
    if (twin) twin.value = v;
  }
  const c = e.target.dataset.color;
  if (c) applyProp(c, e.target.value, false);
});
propsBody.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.select) { applyProp(t.dataset.select, t.value, true); return; }
  if (t.dataset.range || t.dataset.num || t.dataset.color) {
    if (S.tool === 'select' && findAnnot()) commit();
    if (t.dataset.color) renderProps();
  }
});

/* =========================================================================
   Modals
   ========================================================================= */
function openModal({ title, sub = '', body, foot, onMount, width }) {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = `<div class="modal" role="dialog" aria-modal="true" ${width ? `style="max-width:${width}px"` : ''}>
    <div class="modal-head"><h3>${title}</h3><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    ${sub ? `<p class="modal-sub">${sub}</p>` : ''}
    <div class="modal-body">${body}</div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
  </div>`;
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('pointerdown', e => { if (e.target === root) close(); });
  root.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  $('modalRoot').append(root);
  onMount?.(root, close);
  root.querySelector('input:not([type=color]):not([type=range]), textarea')?.focus();
  return close;
}

/* ----- Signature ----- */
const SIG_KEY = 'folio-signatures';
const savedSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY)) || []; } catch { return []; } };

function trimCanvas(c) {
  const ctx = c.getContext('2d');
  const { width, height } = c;
  const d = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (d[(y * width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function placeSignature(dataUrl) {
  const img = await loadImage(dataUrl);
  const sigs = savedSigs().filter(s => s !== dataUrl);
  sigs.unshift(dataUrl);
  try { localStorage.setItem(SIG_KEY, JSON.stringify(sigs.slice(0, 4))); } catch {}
  const targetW = 170;
  insertImageAnnot(dataUrl, targetW, targetW * img.naturalHeight / img.naturalWidth, { label: 'Signature' });
}

function openSignatureModal() {
  if (!S.pages.length) return toast('Open a PDF first.', 'error');
  const saved = savedSigs();
  const sigColors = ['#111827', '#1e3a8a', '#1d4ed8', '#b91c1c'];
  openModal({
    title: 'Add your signature',
    sub: 'Draw, type or upload. Your signature is saved only in this browser.',
    width: 560,
    body: `
      ${saved.length ? `<div><span class="field-label">Saved signatures</span><div class="sig-saved">${saved.map((s, i) => `<button data-saved="${i}" title="Use this signature"><img src="${s}" alt="Saved signature ${i + 1}"></button>`).join('')}</div></div>` : ''}
      <div class="tabs" role="tablist"><button class="on" data-tab="draw">Draw</button><button data-tab="type">Type</button><button data-tab="upload">Upload</button></div>
      <div data-pane="draw"><canvas class="sig-pad" id="sigPad"></canvas></div>
      <div data-pane="type" hidden>
        <input class="input" id="sigText" placeholder="Type your full name" value="">
        <div class="field-row" style="margin:10px 0">
          <select class="select" id="sigFont"><option value="Dancing Script">Dancing Script</option><option value="Great Vibes">Great Vibes</option><option value="Caveat">Caveat</option></select>
        </div>
        <div class="sig-preview" id="sigPreview" style="font-family:'Dancing Script'">Your name</div>
      </div>
      <div data-pane="upload" hidden>
        <label class="btn" style="width:100%">${icon('upload', 16)} Choose an image of your signature<input type="file" accept="image/*" id="sigUpload" hidden></label>
        <p class="props-note" style="margin:10px 0 0">Tip: use a PNG with a transparent background for the cleanest result.</p>
      </div>
      <div class="field"><span class="field-label">Ink color</span><div class="swatches">${sigColors.map((c, i) => `<button class="swatch${i === 1 ? ' on' : ''}" style="background:${c}" data-ink="${c}"></button>`).join('')}</div></div>`,
    foot: `<button class="btn left" id="sigClear">Clear</button><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="sigUse">${icon('check', 16)} Use signature</button>`,
    onMount(root, close) {
      let tab = 'draw', ink = sigColors[1], drawn = false;
      const pad = root.querySelector('#sigPad');
      const dpr = window.devicePixelRatio || 1;
      const sizePad = () => { const r = pad.getBoundingClientRect(); pad.width = r.width * dpr; pad.height = r.height * dpr; };
      requestAnimationFrame(sizePad);
      const ctx = () => pad.getContext('2d');
      let last = null;
      pad.addEventListener('pointerdown', e => {
        pad.setPointerCapture(e.pointerId);
        const r = pad.getBoundingClientRect();
        last = [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
        const c = ctx(); c.fillStyle = ink; c.beginPath(); c.arc(last[0], last[1], 1.4 * dpr, 0, Math.PI * 2); c.fill();
        drawn = true;
      });
      pad.addEventListener('pointermove', e => {
        if (!last) return;
        const r = pad.getBoundingClientRect();
        const pt = [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
        const c = ctx();
        c.strokeStyle = ink; c.lineWidth = 2.6 * dpr; c.lineCap = 'round'; c.lineJoin = 'round';
        c.beginPath(); c.moveTo(...last); c.lineTo(...pt); c.stroke();
        last = pt;
      });
      const up = () => (last = null);
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointercancel', up);

      const text = root.querySelector('#sigText'), font = root.querySelector('#sigFont'), prev = root.querySelector('#sigPreview');
      const syncPrev = () => { prev.textContent = text.value || 'Your name'; prev.style.fontFamily = `'${font.value}'`; prev.style.color = ink; };
      text.addEventListener('input', syncPrev);
      font.addEventListener('change', syncPrev);

      root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
        tab = b.dataset.tab;
        root.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
        root.querySelectorAll('[data-pane]').forEach(p => (p.hidden = p.dataset.pane !== tab));
        if (tab === 'draw') requestAnimationFrame(sizePad), (drawn = false);
        if (tab === 'type') text.focus();
      }));
      root.querySelectorAll('[data-ink]').forEach(b => b.addEventListener('click', () => {
        ink = b.dataset.ink;
        root.querySelectorAll('[data-ink]').forEach(x => x.classList.toggle('on', x === b));
        syncPrev();
      }));
      root.querySelectorAll('[data-saved]').forEach(b => b.addEventListener('click', () => { close(); placeSignature(saved[Number(b.dataset.saved)]); }));
      root.querySelector('#sigClear').addEventListener('click', () => {
        if (tab === 'draw') { ctx().clearRect(0, 0, pad.width, pad.height); drawn = false; }
        else if (tab === 'type') { text.value = ''; syncPrev(); }
      });
      root.querySelector('#sigUpload').addEventListener('change', async e => {
        const f = e.target.files[0];
        if (!f) return;
        const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
        const img = await loadImage(url);
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        close();
        placeSignature(c.toDataURL('image/png'));
      });
      root.querySelector('#sigUse').addEventListener('click', async () => {
        let out;
        if (tab === 'draw') {
          if (!drawn) return toast('Draw your signature first.', 'error');
          out = trimCanvas(pad);
        } else if (tab === 'type') {
          if (!text.value.trim()) return toast('Type your name first.', 'error');
          await document.fonts.load(`96px '${font.value}'`);
          const c = document.createElement('canvas');
          const cx = c.getContext('2d');
          cx.font = `96px '${font.value}'`;
          c.width = Math.ceil(cx.measureText(text.value).width) + 60;
          c.height = 180;
          const c2 = c.getContext('2d');
          c2.font = `96px '${font.value}'`;
          c2.fillStyle = ink;
          c2.textBaseline = 'middle';
          c2.fillText(text.value, 30, 90);
          out = trimCanvas(c);
        } else return toast('Choose an image to upload.', 'error');
        if (!out) return toast('Signature is empty.', 'error');
        close();
        placeSignature(out.toDataURL('image/png'));
      });
    },
  });
}

/* ----- Watermark ----- */
function openWatermarkModal() {
  if (!S.pages.length) return toast('Open a PDF first.', 'error');
  const wm = S.settings.watermark || { text: 'CONFIDENTIAL', size: 64, opacity: 0.15, color: '#ef4444' };
  openModal({
    title: 'Watermark',
    sub: 'Stamp diagonal text across every page.',
    body: `
      <div class="field"><label>Text</label><input class="input" id="wmText" value="${esc(wm.text)}" maxlength="60"></div>
      <div class="field"><label>Size</label><div class="field-row"><input type="range" id="wmSize" min="16" max="160" value="${wm.size}"><span class="range-val" id="wmSizeV">${wm.size}pt</span></div></div>
      <div class="field"><label>Opacity</label><div class="field-row"><input type="range" id="wmOp" min="0.05" max="0.8" step="0.05" value="${wm.opacity}"><span class="range-val" id="wmOpV">${Math.round(wm.opacity * 100)}%</span></div></div>
      <div class="field"><label>Color</label><div class="swatches">${['#ef4444', '#111827', '#64748b', '#4f46e5', '#16a34a'].map(c => `<button class="swatch${c === wm.color ? ' on' : ''}" style="background:${c}" data-c="${c}"></button>`).join('')}</div></div>`,
    foot: `${S.settings.watermark ? '<button class="btn btn-danger left" id="wmRemove">Remove</button>' : ''}<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="wmApply">Apply to all pages</button>`,
    onMount(root, close) {
      let color = wm.color;
      root.querySelector('#wmSize').addEventListener('input', e => (root.querySelector('#wmSizeV').textContent = `${e.target.value}pt`));
      root.querySelector('#wmOp').addEventListener('input', e => (root.querySelector('#wmOpV').textContent = `${Math.round(e.target.value * 100)}%`));
      root.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', () => { color = b.dataset.c; root.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', x === b)); }));
      root.querySelector('#wmRemove')?.addEventListener('click', () => { S.settings.watermark = null; S.pages.forEach(renderAnnots); commit(); close(); toast('Watermark removed'); });
      root.querySelector('#wmApply').addEventListener('click', () => {
        const text = root.querySelector('#wmText').value.trim();
        if (!text) return toast('Enter watermark text.', 'error');
        S.settings.watermark = { text, size: Number(root.querySelector('#wmSize').value), opacity: Number(root.querySelector('#wmOp').value), color };
        S.pages.forEach(renderAnnots);
        commit();
        close();
        toast('Watermark applied', 'success');
      });
    },
  });
}

/* ----- Page numbers ----- */
function openPageNumbersModal() {
  if (!S.pages.length) return toast('Open a PDF first.', 'error');
  const pn = S.settings.pageNumbers || { position: 'bottom-center', format: 'Page {n} of {total}', start: 1, size: 10, color: '#334155' };
  const positions = { 'bottom-center': 'Bottom center', 'bottom-right': 'Bottom right', 'bottom-left': 'Bottom left', 'top-center': 'Top center', 'top-right': 'Top right', 'top-left': 'Top left' };
  const formats = ['{n}', 'Page {n}', 'Page {n} of {total}', '{n} / {total}', '- {n} -'];
  openModal({
    title: 'Page numbers',
    sub: 'Add numbering to every page of the document.',
    body: `
      <div class="field"><label>Position</label><select class="select" id="pnPos">${Object.entries(positions).map(([k, v]) => `<option value="${k}"${k === pn.position ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>Format</label><select class="select" id="pnFmt">${formats.map(f => `<option value="${esc(f)}"${f === pn.format ? ' selected' : ''}>${esc(f.replace('{n}', '1').replace('{total}', String(S.pages.length)))}</option>`).join('')}</select></div>
      <div class="field-row">
        <div class="field" style="flex:1"><label>Start at</label><input class="input" type="number" id="pnStart" min="0" value="${pn.start}"></div>
        <div class="field" style="flex:1"><label>Font size</label><input class="input" type="number" id="pnSize" min="6" max="36" value="${pn.size}"></div>
      </div>`,
    foot: `${S.settings.pageNumbers ? '<button class="btn btn-danger left" id="pnRemove">Remove</button>' : ''}<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="pnApply">Apply</button>`,
    onMount(root, close) {
      root.querySelector('#pnRemove')?.addEventListener('click', () => { S.settings.pageNumbers = null; S.pages.forEach(renderAnnots); commit(); close(); toast('Page numbers removed'); });
      root.querySelector('#pnApply').addEventListener('click', () => {
        S.settings.pageNumbers = {
          position: root.querySelector('#pnPos').value,
          format: root.querySelector('#pnFmt').value,
          start: Math.max(0, parseInt(root.querySelector('#pnStart').value, 10) || 1),
          size: clamp(Number(root.querySelector('#pnSize').value) || 10, 6, 36),
          color: '#334155',
        };
        S.pages.forEach(renderAnnots);
        commit();
        close();
        toast('Page numbers added', 'success');
      });
    },
  });
}

/* ----- Extract / split ----- */
function parseRanges(str, max) {
  const out = [];
  for (const part of str.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) return null;
    let a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < 1 || a > max || b > max) return null;
    const step = a <= b ? 1 : -1;
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) out.push(i - 1);
  }
  return out.length ? out : null;
}

function openExtractModal() {
  if (!S.pages.length) return toast('Open a PDF first.', 'error');
  openModal({
    title: 'Split / extract pages',
    sub: `Create a new PDF from selected pages (document has ${S.pages.length} page${S.pages.length > 1 ? 's' : ''}).`,
    body: `
      <div class="field"><label>Pages to extract</label><input class="input" id="exRange" placeholder="e.g. 1-3, 5, 8-10" value="${S.current + 1}"></div>
      <label class="field-row" style="font-size:14px;gap:10px"><input type="checkbox" id="exRemove"> Remove these pages from the current document</label>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="exGo">${icon('download', 16)} Extract &amp; download</button>`,
    onMount(root, close) {
      root.querySelector('#exGo').addEventListener('click', async () => {
        const idx = parseRanges(root.querySelector('#exRange').value, S.pages.length);
        if (!idx) return toast(`Enter valid page numbers between 1 and ${S.pages.length}.`, 'error');
        const remove = root.querySelector('#exRemove').checked;
        if (remove && new Set(idx).size >= S.pages.length) return toast('You cannot remove every page.', 'error');
        close();
        const base = S.fileName.replace(/\.pdf$/i, '');
        await exportPdf(idx.map(i => S.pages[i]), `${base}-pages.pdf`);
        if (remove) {
          const ids = new Set(idx.map(i => S.pages[i].id));
          S.pages = S.pages.filter(p => !ids.has(p.id));
          S.current = 0;
          rebuildAll();
          commit();
        }
      });
    },
  });
}

/* ----- Document properties ----- */
function openMetaModal() {
  if (!S.pages.length) return toast('Open a PDF first.', 'error');
  const m = S.meta;
  openModal({
    title: 'Document properties',
    sub: 'Metadata embedded in the exported PDF.',
    body: ['title', 'author', 'subject', 'keywords'].map(k => `<div class="field"><label>${k[0].toUpperCase() + k.slice(1)}</label><input class="input" data-meta="${k}" value="${esc(m[k] || '')}" ${k === 'keywords' ? 'placeholder="comma, separated"' : ''}></div>`).join(''),
    foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="metaSave">Save</button>`,
    onMount(root, close) {
      root.querySelector('#metaSave').addEventListener('click', () => {
        root.querySelectorAll('[data-meta]').forEach(i => (S.meta[i.dataset.meta] = i.value.trim()));
        commit();
        close();
        toast('Properties saved', 'success');
      });
    },
  });
}

function openShortcutsModal() {
  const rows = [
    ['Select / Edit text / Add text', 'V · E · T'], ['Draw / Highlight / Whiteout', 'D · H · W'], ['Rectangle / Ellipse / Line / Arrow', 'R · O · L · A'],
    ['Image / Signature', 'I · S'], ['Undo / Redo', 'Ctrl Z · Ctrl Y'], ['Copy / Paste / Duplicate', 'Ctrl C · Ctrl V · Ctrl D'],
    ['Delete selection', 'Del'], ['Nudge selection', '← ↑ → ↓ (Shift ×10)'], ['Zoom in / out / fit', '+ · − · 0'],
    ['Open / Download', 'Ctrl O · Ctrl S'], ['Finish editing / deselect', 'Esc'],
  ];
  openModal({
    title: 'Keyboard shortcuts',
    body: `<div class="shortcut-list">${rows.map(([a, b]) => `<span>${a}</span><span>${b.split(' · ').map(k => `<kbd>${k}</kbd>`).join(' ')}</span>`).join('')}</div>`,
    foot: '<button class="btn btn-primary" data-close>Got it</button>',
  });
}

/* =========================================================================
   Export
   ========================================================================= */
async function exportPdf(pages = S.pages, name = S.fileName) {
  if (!pages.length) return;
  if (S.editing) finishEdit();
  setLoading(true, 'Preparing your PDF…');
  try {
    const bytes = await buildPdf({ sources: S.sources, pages, settings: S.settings, meta: S.meta });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`Downloaded ${a.download} (${(bytes.length / 1024).toFixed(0)} KB)`, 'success');
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + (err.message || err), 'error');
  } finally {
    setLoading(false);
  }
}

/* =========================================================================
   Global UI wiring
   ========================================================================= */
function closeDrawers() {
  $('sidebar').classList.remove('open');
  $('props').classList.remove('open');
}

function initChrome() {
  initTheme();
  hydrateIcons();
  document.querySelectorAll('.js-year').forEach(el => (el.textContent = new Date().getFullYear()));
  buildToolrail();

  const themeBtn = $('themeBtn');
  const syncTheme = () => (themeBtn.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'));
  syncTheme();
  themeBtn.addEventListener('click', () => { toggleTheme(); syncTheme(); });

  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('zoomIn').addEventListener('click', () => setZoom(S.zoom * 1.2));
  $('zoomOut').addEventListener('click', () => setZoom(S.zoom / 1.2));
  $('zoomVal').addEventListener('click', () => fitZoom(true));
  $('downloadBtn').addEventListener('click', () => exportPdf());
  $('emptyOpen').addEventListener('click', () => $('openInput').click());
  $('emptyBlank').addEventListener('click', newBlankDocument);
  $('addBlankBtn').addEventListener('click', insertBlankPage);
  $('mergeBtn').addEventListener('click', () => $('mergeInput').click());
  $('toggleSidebar').addEventListener('click', () => { $('props').classList.remove('open'); $('sidebar').classList.toggle('open'); });
  $('toggleProps').addEventListener('click', () => { $('sidebar').classList.remove('open'); $('props').classList.toggle('open'); });

  $('fileName').addEventListener('change', e => {
    let v = e.target.value.trim() || 'document.pdf';
    if (!/\.pdf$/i.test(v)) v += '.pdf';
    e.target.value = S.fileName = v;
    scheduleSave();
  });
  $('fileName').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

  $('openInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) handleOpenFile(f); });
  $('mergeInput').addEventListener('change', async e => {
    const files = [...e.target.files].filter(isPdf);
    e.target.value = '';
    for (const f of files) {
      if (!S.pages.length) await openPdf(await readFile(f), f.name);
      else await appendPdf(await readFile(f), f.name);
    }
  });
  $('imageInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) insertImageFile(f); });

  // Tools menu
  const menu = $('toolsMenu');
  $('toolsMenuBtn').addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) menu.hidden = true; });
  menu.addEventListener('click', e => {
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (!act) return;
    menu.hidden = true;
    ({
      open: () => $('openInput').click(),
      merge: () => $('mergeInput').click(),
      blank: insertBlankPage,
      extract: openExtractModal,
      watermark: openWatermarkModal,
      pageNumbers: openPageNumbersModal,
      meta: openMetaModal,
      shortcuts: openShortcutsModal,
      new: () => { if (S.pages.length && confirm('Close this document? Your local autosave will be cleared.')) closeDocument(); },
    })[act]?.();
  });

  // Drag & drop files anywhere
  let dragDepth = 0;
  const overlay = $('dropOverlay');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.querySelector('p').textContent = S.pages.length ? 'Drop a PDF to append pages, or an image to insert it' : 'Drop PDF to open';
    overlay.classList.add('show');
  });
  addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove('show'); } });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove('show');
    const files = [...e.dataTransfer.files];
    for (const f of files) {
      if (isPdf(f)) {
        if (!S.pages.length) await openPdf(await readFile(f), f.name);
        else await appendPdf(await readFile(f), f.name);
      } else if (isImage(f) && S.pages.length) {
        await insertImageFile(f);
      }
    }
  });

  // Keyboard shortcuts
  addEventListener('keydown', e => {
    if ($('modalRoot').children.length) return;
    const t = e.target;
    const typing = t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (S.editing) {
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(); }
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('openInput').click(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (S.pages.length) exportPdf(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (mod && e.key.toLowerCase() === 'c') { const a = findAnnot(); if (a) { clipboard = clone(a); toast('Copied'); } return; }
    if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
    if (mod) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (S.sel) { e.preventDefault(); deleteSelected(); } return; }
    if (e.key === 'Escape') { if (S.sel) deselect(); else if (S.tool !== 'select') setTool('select'); return; }
    if (e.key === 'Enter' && S.sel) { const a = findAnnot(); if (a?.type === 'text') { e.preventDefault(); startEdit(getPage(S.sel.pageId), a); } return; }
    if (e.key.startsWith('Arrow') && S.sel) {
      e.preventDefault();
      const a = findAnnot();
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      moveAnnot(a, clone(a), d[0], d[1]);
      renderAnnots(getPage(S.sel.pageId));
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(commit, 400);
      return;
    }
    if (e.key === '+' || e.key === '=') { setZoom(S.zoom * 1.2); return; }
    if (e.key === '-') { setZoom(S.zoom / 1.2); return; }
    if (e.key === '0') { fitZoom(true); return; }
    const tool = TOOLS.find(x => x !== '-' && x.key === e.key.toLowerCase());
    if (tool && S.pages.length) setTool(tool.id);
  });
  let nudgeTimer = 0;

  addEventListener('resize', () => { if (innerWidth > 900) closeDrawers(); });
}

/* =========================================================================
   Boot
   ========================================================================= */
async function restoreSession(session) {
  setLoading(true, 'Restoring your last session…');
  try {
    for (const s of session.sources) await addSource(s.bytes, s.name);
    const data = JSON.parse(session.data);
    S.pages = data.pages;
    S.settings = data.settings;
    S.meta = data.meta;
    S.fileName = session.fileName || 'document.pdf';
    $('fileName').value = S.fileName;
    fitZoom();
    rebuildAll();
    resetHistory();
    toast('Restored your previous session', 'success');
  } catch (err) {
    console.error(err);
    closeDocument(true);
    kv.del('session');
  } finally {
    setLoading(false);
  }
}

async function boot() {
  initChrome();
  rebuildAll();
  const params = new URLSearchParams(location.search);
  if (params.get('open') === 'pending') {
    history.replaceState(null, '', location.pathname);
    const pending = await kv.get('pending');
    await kv.del('pending');
    if (pending?.bytes) return openPdf(pending.bytes, pending.name);
  }
  const session = await kv.get('session');
  if (session?.sources && session.data) restoreSession(session);
}

boot();
