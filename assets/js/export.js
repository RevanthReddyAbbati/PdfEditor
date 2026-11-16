// Builds the final PDF with pdf-lib. Annotations are stored in "display space"
// (points, origin top-left, page as the user sees it incl. rotation) and are
// mapped back into each page's PDF user space here.

import { FONTS, FALLBACK_FONT, SUBSET_NAMES, fontUrl, baselineRatio } from './fonts.js';

const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, BlendMode } = window.PDFLib;

const FONT_MAP = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const norm = r => ((r % 360) + 360) % 360;

function makeMapper(box, R) {
  const { x: x0, y: y0, width: W, height: H } = box;
  return (dx, dy) => {
    let u, v;
    switch (R) {
      case 90: u = dy; v = dx; break;
      case 180: u = W - dx; v = dy; break;
      case 270: u = W - dy; v = H - dx; break;
      default: u = dx; v = H - dy;
    }
    return { x: x0 + u, y: y0 + v };
  };
}

export function pageNumberText(cfg, n, total) {
  return cfg.format.replace(/\{n\}/g, String(n + cfg.start - 1)).replace(/\{total\}/g, String(total + cfg.start - 1));
}

/**
 * @param {object} opts
 * @param {Array} opts.sources  [{bytes}]
 * @param {Array} opts.pages    page models (see app.js)
 * @param {object} opts.settings watermark / pageNumbers
 * @param {object} opts.meta    {title, author, subject, keywords}
 */
export async function buildPdf({ sources, pages, settings, meta }) {
  const out = await PDFDocument.create();
  const loaded = new Map();
  const getSrc = async i => {
    if (!loaded.has(i)) loaded.set(i, await PDFDocument.load(sources[i].bytes, { ignoreEncryption: true }));
    return loaded.get(i);
  };

  out.registerFontkit(window.fontkit);

  // Fonts are embedded lazily: a font (or a fallback) is only added when a character needs it
  const fontCache = new Map();
  const embedStd = (family, bold, italic) => {
    const name = (FONT_MAP[family] || FONT_MAP.Helvetica)[(bold ? 1 : 0) + (italic ? 2 : 0)];
    if (!fontCache.has(name)) fontCache.set(name, out.embedFont(StandardFonts[name]));
    return fontCache.get(name);
  };
  const embedCustom = (family, bold, italic, subset) => {
    const url = fontUrl(FONTS[family].id, subset, bold, italic);
    if (!fontCache.has(url)) {
      fontCache.set(url, (async () => {
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const font = await out.embedFont(bytes, { subset: true });
        font.__glyphs = window.fontkit.create(bytes);
        return font;
      })());
    }
    return fontCache.get(url);
  };
  const fontChain = (family = 'Helvetica', bold = false, italic = false) => {
    const f = FONTS[family] || FONTS.Helvetica;
    const chain = f.std ? [() => embedStd(family in FONTS ? family : 'Helvetica', bold, italic)]
      : SUBSET_NAMES.map(s => () => embedCustom(family, bold, italic, s));
    if (family !== FALLBACK_FONT) chain.push(...SUBSET_NAMES.map(s => () => embedCustom(FALLBACK_FONT, bold, italic, s)));
    return chain;
  };
  const hasGlyph = (font, ch) => {
    if (font.__glyphs) return font.__glyphs.hasGlyphForCodePoint(ch.codePointAt(0));
    try { font.encodeText(ch); return true; } catch { return false; }
  };

  // Split text into runs, each drawn with the first font in the chain that has the glyphs
  const buildRuns = async (text, chain) => {
    const runs = [];
    for (let ch of text.replace(/\t/g, '    ')) {
      const last = runs[runs.length - 1];
      let font = null;
      if (last && (ch === ' ' || hasGlyph(last.font, ch))) font = last.font;
      else {
        for (const get of chain) { const f = await get(); if (hasGlyph(f, ch)) { font = f; break; } }
      }
      if (!font) { font = await chain[0](); ch = '?'; }
      if (last && last.font === font) last.text += ch;
      else runs.push({ font, text: ch });
    }
    return runs;
  };
  const runsWidth = (runs, size) => runs.reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0);

  // Draw runs starting at display point (sx, sy) along display direction (dx, dy)
  const drawRuns = (page, m, runs, { sx, sy, dir = [1, 0], size, rotate, color, opacity }) => {
    let off = 0;
    for (const r of runs) {
      const pt = m(sx + dir[0] * off, sy + dir[1] * off);
      page.drawText(r.text, { x: pt.x, y: pt.y, size, font: r.font, color, opacity, rotate });
      off += r.font.widthOfTextAtSize(r.text, size);
    }
  };
  const imgCache = new Map();
  const getImage = async dataUrl => {
    if (!imgCache.has(dataUrl)) {
      const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0));
      imgCache.set(dataUrl, dataUrl.startsWith('data:image/jpeg') ? await out.embedJpg(bytes) : await out.embedPng(bytes));
    }
    return imgCache.get(dataUrl);
  };

  const total = pages.length;
  for (let n = 0; n < pages.length; n++) {
    const p = pages[n];
    let page;
    let base = 0;
    if (p.src == null) {
      page = out.addPage([p.bw, p.bh]);
    } else {
      const src = await getSrc(p.src);
      const [copied] = await out.copyPages(src, [p.index]);
      page = out.addPage(copied);
      base = norm(page.getRotation().angle);
    }
    const R = norm(base + p.rotation);
    page.setRotation(degrees(R));
    const box = page.getCropBox();
    const m = makeMapper(box, R);
    const rot = degrees(R);

    for (const a of p.annots) {
      const opacity = a.opacity ?? 1;
      switch (a.type) {
        case 'rect':
        case 'highlight':
        case 'whiteout': {
          const pt = m(a.x, a.y + a.h);
          const o = { x: pt.x, y: pt.y, width: a.w, height: a.h, rotate: rot };
          if (a.type === 'highlight') Object.assign(o, { color: hexToRgb(a.color), opacity: 0.4 * opacity, blendMode: BlendMode.Multiply });
          else if (a.type === 'whiteout') Object.assign(o, { color: hexToRgb(a.fill || '#ffffff'), opacity });
          else {
            if (a.fill && a.fill !== 'none') Object.assign(o, { color: hexToRgb(a.fill), opacity });
            if (a.width > 0) Object.assign(o, { borderColor: hexToRgb(a.color), borderWidth: a.width, borderOpacity: opacity });
          }
          page.drawRectangle(o);
          break;
        }
        case 'ellipse': {
          const c = m(a.x + a.w / 2, a.y + a.h / 2);
          const swap = R === 90 || R === 270;
          const o = { x: c.x, y: c.y, xScale: (swap ? a.h : a.w) / 2, yScale: (swap ? a.w : a.h) / 2 };
          if (a.fill && a.fill !== 'none') Object.assign(o, { color: hexToRgb(a.fill), opacity });
          if (a.width > 0) Object.assign(o, { borderColor: hexToRgb(a.color), borderWidth: a.width, borderOpacity: opacity });
          page.drawEllipse(o);
          break;
        }
        case 'line':
        case 'arrow': {
          const line = (x1, y1, x2, y2) => page.drawLine({ start: m(x1, y1), end: m(x2, y2), thickness: a.width, color: hexToRgb(a.color), opacity, lineCap: LineCapStyle.Round });
          line(a.x1, a.y1, a.x2, a.y2);
          if (a.type === 'arrow') {
            for (const [hx, hy] of arrowHead(a)) line(a.x2, a.y2, hx, hy);
          }
          break;
        }
        case 'draw': {
          const pts = a.points;
          const color = hexToRgb(a.color);
          if (pts.length === 1) {
            const c = m(pts[0][0], pts[0][1]);
            page.drawCircle({ x: c.x, y: c.y, size: a.width / 2, color, opacity });
          }
          for (let i = 1; i < pts.length; i++) {
            page.drawLine({ start: m(pts[i - 1][0], pts[i - 1][1]), end: m(pts[i][0], pts[i][1]), thickness: a.width, color, opacity, lineCap: LineCapStyle.Round });
          }
          break;
        }
        case 'text': {
          const chain = fontChain(a.font, a.bold, a.italic);
          const k = await baselineRatio(a.font, a.bold, a.italic);
          const lines = a.text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            const runs = await buildRuns(lines[i], chain);
            drawRuns(page, m, runs, { sx: a.x, sy: a.y + i * a.size * 1.2 + k * a.size, size: a.size, rotate: rot, color: hexToRgb(a.color), opacity });
          }
          break;
        }
        case 'image': {
          const img = await getImage(a.src);
          const pt = m(a.x, a.y + a.h);
          page.drawImage(img, { x: pt.x, y: pt.y, width: a.w, height: a.h, rotate: rot, opacity });
          break;
        }
      }
    }

    const dw = R % 180 ? box.height : box.width;
    const dh = R % 180 ? box.width : box.height;

    const wm = settings.watermark;
    if (wm && wm.text) {
      const runs = await buildRuns(wm.text, fontChain('Helvetica', true));
      const w = runsWidth(runs, wm.size);
      const c = Math.SQRT1_2;
      const cx = dw / 2, cy = dh / 2;
      const sx = cx - c * w / 2 + c * 0.346 * wm.size;
      const sy = cy + c * w / 2 + c * 0.346 * wm.size;
      drawRuns(page, m, runs, { sx, sy, dir: [c, -c], size: wm.size, rotate: degrees(R + 45), color: hexToRgb(wm.color), opacity: wm.opacity });
    }

    const pn = settings.pageNumbers;
    if (pn) {
      const size = pn.size;
      const runs = await buildRuns(pageNumberText(pn, n + 1, total), fontChain('Helvetica'));
      const w = runsWidth(runs, size);
      const margin = 28;
      const [vert, horiz] = pn.position.split('-');
      const x = horiz === 'left' ? margin : horiz === 'right' ? dw - margin - w : (dw - w) / 2;
      const baseline = vert === 'top' ? margin + size * 0.8 : dh - margin;
      drawRuns(page, m, runs, { sx: x, sy: baseline, size, rotate: rot, color: hexToRgb(pn.color) });
    }
  }

  if (meta.title) out.setTitle(meta.title);
  if (meta.author) out.setAuthor(meta.author);
  if (meta.subject) out.setSubject(meta.subject);
  if (meta.keywords) out.setKeywords(meta.keywords.split(',').map(s => s.trim()).filter(Boolean));
  out.setProducer('Folio PDF — by Revanth Reddy Abbati');
  out.setCreator('Folio PDF');
  out.setModificationDate(new Date());
  return out.save();
}

export function arrowHead(a) {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const len = Math.max(10, a.width * 4);
  const spread = Math.PI / 7;
  return [
    [a.x2 - len * Math.cos(ang - spread), a.y2 - len * Math.sin(ang - spread)],
    [a.x2 - len * Math.cos(ang + spread), a.y2 - len * Math.sin(ang + spread)],
  ];
}
