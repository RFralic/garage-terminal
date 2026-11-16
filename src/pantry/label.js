// label.js: homemade-batch labels for a thermal label printer.
//
// Made for the Katasymbol (Supvan) T50M, which has no open way to print to it
// straight from a web page, so the label is saved as an image to print from
// the Katasymbol app (add Image, stretch to fill, print one per jar).
//
// Each image is the label's exact size in printer dots at 203 dpi (8 dots per mm),
// pure black and white (no gray, so bars and text print sharp), with the
// 203 dpi setting stored in the PNG. Tested Nov 16, 2026: the 30 × 20 mm label
// printed on the T50M and scanned in the Logbook.

import { code128cModules, code128cWidth, QUIET } from './code128.js';
import { fmtMDY, fmtMY, spacedCode } from './logic.js';

export const DPI = 203;
const DOTS_PER_MM = 8;

export const LABEL_SIZES = {
  '30x20': { w: 30, h: 20, name: '30 × 20 mm', hint: 'Name, date, barcode' },
  '40x30': { w: 40, h: 30, name: '40 × 30 mm', hint: 'Name, method, dates, barcode' },
  '50x80': { w: 50, h: 80, name: '50 × 80 mm', hint: 'Everything, plus notes' },
};

const SANS = 'Inter, "Helvetica Neue", Arial, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

/** Waits for the label fonts, so the first label isn't drawn in a fallback font. */
export async function fontsReady() {
  if (!document.fonts) return;
  await Promise.all([
    document.fonts.load(`700 24px ${SANS}`), document.fonts.load(`400 18px ${SANS}`), document.fonts.load(`400 18px ${MONO}`),
  ]).catch(() => {});
}

function fitFont(ctx, weight, family, text, maxW, start, min) {
  for (let px = start; px > min; px--) {
    ctx.font = `${weight} ${px}px ${family}`;
    if (ctx.measureText(text).width <= maxW) return px;
  }
  ctx.font = `${weight} ${min}px ${family}`;
  return min;
}

function wrap(ctx, text, maxW) {
  const lines = [];
  let cur = '';
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function bars(ctx, digits, x, y, module, height) {
  let cx = x + QUIET * module;
  for (const m of code128cModules(digits)) {
    if (m) ctx.fillRect(cx, y, module, height);
    cx += module;
  }
}

/**
 * Draws a label. `d` = { name, method, size, made, useBy, notes, household, code, batch }
 * (dates as "YYYY-MM-DD", code = the 8-digit batch code). Returns a canvas.
 */
export function renderLabel(d, sizeKey) {
  const s = LABEL_SIZES[sizeKey];
  const W = s.w * DOTS_PER_MM, H = s.h * DOTS_PER_MM;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
  const made = d.made ? `Made ${fmtMDY(d.made)}` : '';
  const useBy = d.useBy ? `Use by ${fmtMY(d.useBy)}` : '';
  const center = (t, y) => { ctx.textAlign = 'center'; ctx.fillText(t, W / 2, y); ctx.textAlign = 'left'; };
  const barsCentered = (module, y, h) => bars(ctx, d.code, Math.floor((W - code128cWidth(d.code, module)) / 2), y, module, h);

  if (sizeKey === '30x20') {
    fitFont(ctx, 700, SANS, d.name, W - 16, 24, 14);
    center(d.name, 4);
    if (made) { fitFont(ctx, 700, SANS, made, W - 16, 18, 12); center(made, 32); }
    barsCentered(2, made ? 56 : 40, made ? 72 : 88);
    ctx.font = `400 18px ${MONO}`;
    center(spacedCode(d.code), 133);
  } else if (sizeKey === '40x30') {
    const m = 10;
    fitFont(ctx, 700, SANS, d.name, W - 2 * m, 30, 16);
    ctx.fillText(d.name, m, 8);
    const l1 = [d.method, d.size].filter(Boolean).join(' · ');
    const l2 = [made, useBy].filter(Boolean).join(' · ');
    if (l1) { fitFont(ctx, 400, SANS, l1, W - 2 * m, 18, 12); ctx.fillText(l1, m, 46); }
    if (l2) { fitFont(ctx, 400, SANS, l2, W - 2 * m, 18, 12); ctx.fillText(l2, m, 70); }
    barsCentered(3, 102, 104);
    ctx.font = `400 19px ${MONO}`;
    center(spacedCode(d.code), 213);
  } else {
    const m = 16;
    let y = 16;
    if (d.household) {
      fitFont(ctx, 700, SANS, d.household.toUpperCase(), W - 2 * m, 18, 12);
      ctx.fillText(d.household.toUpperCase(), m, y);
      y += 32;
      ctx.fillRect(m, y, W - 2 * m, 3);
      y += 16;
    }
    ctx.font = `700 44px ${SANS}`;
    for (const line of wrap(ctx, d.name, W - 2 * m).slice(0, 3)) {
      fitFont(ctx, 700, SANS, line, W - 2 * m, 44, 24);
      ctx.fillText(line, m, y);
      y += 52;
    }
    y += 6;
    const isCount = /\b(count|pieces|servings)$/.test(d.size || '');
    const rows = [['Method', d.method], [isCount ? 'Count' : 'Size', d.size], ['Made', d.made && fmtMDY(d.made)], ['Use by', d.useBy && fmtMY(d.useBy)]].filter((r) => r[1]);
    for (const [k, v] of rows) {
      ctx.font = `400 25px ${SANS}`;
      ctx.fillText(k, m, y);
      fitFont(ctx, 700, SANS, v, W - 2 * m - 110, 25, 14);
      ctx.textAlign = 'right'; ctx.fillText(v, W - m, y); ctx.textAlign = 'left';
      y += 36;
    }
    if (d.notes) {
      y += 4;
      ctx.fillRect(m, y, W - 2 * m, 2);
      y += 14;
      ctx.font = `400 21px ${SANS}`;
      const maxLines = Math.max(0, Math.floor((H - 16 - 32 - 8 - 150 - 12 - y) / 27));
      for (const line of wrap(ctx, d.notes, W - 2 * m).slice(0, maxLines)) { ctx.fillText(line, m, y); y += 27; }
    }
    const module = code128cWidth(d.code, 4) <= W ? 4 : 3;
    barsCentered(module, H - 16 - 30 - 8 - 150, 150);
    ctx.font = `400 23px ${MONO}`;
    center(`${spacedCode(d.code)}  ·  Batch ${d.batch}`, H - 16 - 28);
  }

  // Pure black and white: no gray edges on the text.
  const img = ctx.getImageData(0, 0, W, H);
  const p = img.data;
  for (let i = 0; i < p.length; i += 4) {
    const v = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 < 140 ? 0 : 255;
    p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------- PNG with the 203 dpi setting stored in it ------------------------------

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Sets a PNG's pixels-per-metre (pHYs) chunk: added after the header, replacing any old one. */
export function withDpi(png, dpi = DPI) {
  const ppm = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(21);
  const v = new DataView(phys.buffer);
  v.setUint32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  v.setUint32(8, ppm); v.setUint32(12, ppm); phys[16] = 1; // unit: metre
  v.setUint32(17, crc32(phys.subarray(4, 17)));
  const src = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts = [png.subarray(0, 8)]; // signature
  for (let at = 8; at + 12 <= png.length;) {
    const len = src.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const end = at + 12 + len;
    if (type !== 'pHYs') parts.push(png.subarray(at, end));
    if (type === 'IHDR') parts.push(phys);
    at = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The canvas as a PNG Blob marked 203 dpi. */
export async function labelBlob(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([withDpi(bytes)], { type: 'image/png' });
}

/** "label-strawberry-jam-batch42-40x30mm.png" */
export function labelFileName(d, sizeKey) {
  const slug = String(d.name || 'label').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'label';
  return `label-${slug}-batch${d.batch}-${sizeKey}mm.png`;
}

/**
 * Saves the image to the device: on Android it lands in Downloads (and shows in
 * the Gallery's Download album), on a computer in the downloads folder.
 *
 * This is the reliable path for the Katasymbol app: sharing an image straight
 * into it opens it as a full-page picture print, not a label. Starting a label
 * in Katasymbol and adding the saved image to it prints at the label's size.
 */
export function saveToPhone(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** True where the phone's share sheet can take an image file. */
export function canShareImages() {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.png', { type: 'image/png' })] }));
  } catch { return false; }
}

/** Opens the phone's share sheet with the image. Returns "shared" or "cancelled". */
export async function shareImage(blob, fileName) {
  try {
    await navigator.share({ files: [new File([blob], fileName, { type: 'image/png' })], title: fileName });
    return 'shared';
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
    throw e;
  }
}
