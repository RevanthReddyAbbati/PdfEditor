# Folio PDF — Private, browser-based PDF editor

Folio PDF is a SaaS-style PDF editor that runs entirely in the browser. Files are never uploaded — everything is processed locally with [pdf.js](https://mozilla.github.io/pdf.js/) (rendering) and [pdf-lib](https://pdf-lib.js.org/) (writing).

**Live:** https://revanthreddyabbati.github.io/PdfEditor/

## Features

- **Edit existing text** — click any line or table cell to replace it; keeps the original font, size, color, weight and background
- **Bundled fonts** (Playfair Display, Merriweather, Roboto, Open Sans, Lato, Montserrat, Poppins, Noto Sans) embedded on export, with automatic fallback for symbols like ₹
- **Add text** with font, size, bold/italic, color and opacity controls
- **eSignatures** — draw, type (script fonts) or upload; saved locally for reuse
- **Annotate** — highlight, freehand draw, rectangles, ellipses, lines, arrows, whiteout
- **Images** — insert PNG/JPEG/WebP/GIF, drag and resize
- **Organize pages** — drag to reorder, rotate, duplicate, delete, insert blank pages
- **Merge** multiple PDFs and **split / extract** page ranges
- **Watermarks**, **page numbers** and **document metadata**
- Undo/redo, copy/paste, keyboard shortcuts, zoom, dark mode
- **Autosave** to IndexedDB — pick up where you left off
- Responsive layout for desktop, tablet and mobile

## Project structure

```
index.html            Landing page
app.html              Editor
assets/css/           base (tokens, footer), landing, app styles
assets/js/app.js      Editor state, rendering, tools, modals
assets/js/export.js   PDF generation (maps annotations into PDF space, incl. rotated pages)
assets/js/icons.js    Inline icon set + theme helpers
assets/js/store.js    Tiny IndexedDB key/value store
assets/js/fonts.js    Font registry, @font-face setup, baseline measurement
assets/fonts/         Bundled TTF fonts (latin + latin-ext subsets)
assets/vendor/        pdf.js 4.4.168, pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1 (vendored)
```

No build step — it's plain HTML, CSS and ES modules.

## Run locally

```bash
npx http-server -p 5173 -c-1
```

Then open http://localhost:5173.

## Deploy

GitHub Pages serves the `gh-pages` branch (a mirror of `main`). In Settings → Pages, set Source to "Deploy from a branch" → `gh-pages` / `root`.

---

© Revanth Reddy Abbati. All rights reserved.
