// Font registry shared by the editor (display) and the exporter (embedding).
// Standard fonts use the PDF base-14 set; the others are bundled TTFs split into
// "latin" and "latin-ext" files (latin-ext carries symbols such as ₹).

export const FONTS = {
  Helvetica: { label: 'Helvetica / Arial', css: 'Helvetica, Arial, sans-serif', std: true },
  Times: { label: 'Times New Roman', css: "'Times New Roman', Times, serif", std: true },
  Courier: { label: 'Courier', css: "'Courier New', Courier, monospace", std: true },
  'Playfair Display': { id: 'playfair-display', serif: true, match: /playfair/ },
  Merriweather: { id: 'merriweather', serif: true, match: /merriweather/ },
  Roboto: { id: 'roboto', match: /roboto/ },
  'Open Sans': { id: 'open-sans', match: /opensans/ },
  Lato: { id: 'lato', match: /lato/ },
  Montserrat: { id: 'montserrat', match: /montserrat/ },
  Poppins: { id: 'poppins', match: /poppins/ },
  'Noto Sans': { id: 'noto-sans', match: /notosans/ },
};

// Used for characters the chosen font cannot draw (e.g. ₹ in Helvetica)
export const FALLBACK_FONT = 'Noto Sans';

const SUBSETS = {
  latin: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  'latin-ext': 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
};
export const SUBSET_NAMES = Object.keys(SUBSETS);

export const fontUrl = (id, subset, bold, italic) =>
  new URL(`../fonts/${id}/${subset}-${bold ? 700 : 400}-${italic ? 'italic' : 'normal'}.ttf`, import.meta.url).href;

export function fontCss(key) {
  const f = FONTS[key] || FONTS.Helvetica;
  return f.css || `'${key}', ${f.serif ? 'serif' : 'sans-serif'}`;
}

// Register @font-face rules so the browser loads bundled fonts on demand
export function installFontFaces() {
  let css = '';
  for (const [name, f] of Object.entries(FONTS)) {
    if (f.std) continue;
    for (const [subset, range] of Object.entries(SUBSETS)) {
      for (const bold of [false, true]) {
        for (const italic of [false, true]) {
          css += `@font-face{font-family:'${name}';font-style:${italic ? 'italic' : 'normal'};font-weight:${bold ? 700 : 400};font-display:swap;src:url('${fontUrl(f.id, subset, bold, italic)}') format('truetype');unicode-range:${range};}\n`;
        }
      }
    }
  }
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
}

// Map a PDF font name (e.g. "QRXCPD+PlayfairDisplay-Bold") to a registry font
export function matchFontFamily(rawName) {
  const n = String(rawName).toLowerCase().replace(/[^a-z]/g, '');
  for (const [name, f] of Object.entries(FONTS)) {
    if (f.match && f.match.test(n)) return name;
  }
  return null;
}

// Where the baseline sits inside a 1.2 line-height box, as a fraction of font size.
// Measured from the browser so display and export agree exactly.
const baselineCache = new Map();
export async function baselineRatio(key, bold = false, italic = false) {
  const id = `${key}|${bold}|${italic}`;
  if (baselineCache.has(id)) return baselineCache.get(id);
  const font = `${italic ? 'italic ' : ''}${bold ? 700 : 400} 100px ${fontCss(key)}`;
  try { await document.fonts.load(font, 'Hg0₹'); } catch {}
  const box = document.createElement('div');
  box.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;line-height:1.2;font:${font};line-height:1.2`;
  box.innerHTML = 'Hg<span style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>';
  document.body.append(box);
  const ratio = box.lastChild.offsetTop / 100;
  box.remove();
  const value = ratio > 0.5 && ratio < 1.2 ? ratio : 0.945;
  baselineCache.set(id, value);
  return value;
}
