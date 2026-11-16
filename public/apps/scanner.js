// Served at /apps/scanner.js. Copied unchanged from the Logbook repo (public/scanner.js)
// by scripts/import-logbook.mjs. Don't edit by hand: re-run the script instead.
/* scanner.js: barcode scanning for the Logbook and the Project Tracker.
 *
 * Two ways to scan, picked on the scanner screen (the choice is remembered on this device):
 *   - Camera: the phone's back camera. Uses the browser's own barcode reader
 *     (BarcodeDetector, built into Chrome on Android). Where there isn't one
 *     (iPhone/Safari, Firefox, Chrome on Windows) a small reader is loaded from
 *     a CDN the first time it's needed.
 *   - Bluetooth: any scanner set to keyboard (HID) mode and paired in the
 *     phone's Bluetooth settings. It "types" the code very fast and ends with
 *     Enter; while the scanner screen is open, a fast burst like that is a scan.
 *     Nothing is listened to when the scanner screen is closed.
 *
 *   GTScan.open({title, allowKeep, onCode})   opens the scanner screen.
 *     onCode({text, format, via}, {keep}) runs for each scan. With "Keep scanning"
 *     ticked the screen stays open and whatever string onCode returns is shown on it.
 *   <input data-scan>   any such input (now or added later) gets a small scan
 *     button; a scan fills the input in and fires its input/change events.
 */
(function () {
  "use strict";

  // ---- settings you might tune ------------------------------------------------
  /** Bluetooth: the longest gap between two keystrokes of one scan, in ms. People type slower. */
  const BURST_GAP_MS = 100;
  /** Bluetooth: the fewest characters that count as a scan. */
  const BURST_MIN = 4;
  /** Camera: the same code read again within this many ms is ignored. */
  const REPEAT_MS = 2000;
  /** Camera: how often a frame is checked, in ms. */
  const FRAME_MS = 150;
  /** The reader loaded when the browser has none of its own (same API as BarcodeDetector). */
  const FALLBACK_URL = "https://cdn.jsdelivr.net/npm/barcode-detector@3.2.4/dist/es/ponyfill.js/+esm";
  const FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8", "code_128", "code_39", "qr_code"];
  const MODE_KEY = "gtScanMode";

  // ---- pure helpers (also used by the tests) ------------------------------------
  /** Trims a scanned code and drops control characters some scanners add. */
  function clean(v) {
    return String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F]/g, "").trim();
  }
  /** True for store barcodes: all digits, 8, 12 or 13 long (EAN-8, UPC-A, EAN-13). */
  function isRetail(v) {
    return /^(\d{8}|\d{12}|\d{13})$/.test(clean(v));
  }
  const FORMAT_NAMES = { upc_a: "UPC", upc_e: "UPC-E", ean_13: "EAN-13", ean_8: "EAN-8", code_128: "Code 128", code_39: "Code 39", qr_code: "QR code" };
  /** A readable name for the barcode type; guessed from the code when the scanner doesn't say. */
  function formatName(format, text) {
    if (format && FORMAT_NAMES[format]) return FORMAT_NAMES[format];
    const t = clean(text);
    if (/^\d{12}$/.test(t)) return "UPC";
    if (/^\d{13}$/.test(t)) return "EAN-13";
    if (/^\d{8}$/.test(t)) return "EAN-8";
    return "";
  }
  /**
   * Bluetooth burst detector. feed(key, timeMs) with each key ("Enter", "a", "7"…);
   * it returns the code when a fast burst of at least BURST_MIN characters ends in
   * Enter or Tab, else null. Slow typing never adds up to a scan.
   */
  function makeBurst(gap, min) {
    gap = gap || BURST_GAP_MS; min = min || BURST_MIN;
    let buf = "", last = -Infinity;
    return {
      feed(key, t) {
        if (t - last > gap) buf = "";
        last = t;
        if (key === "Enter" || key === "Tab") {
          const code = clean(buf); buf = "";
          return code.length >= min ? code : null;
        }
        if (typeof key === "string" && key.length === 1) buf += key;
        return null;
      },
      reset() { buf = ""; last = -Infinity; },
      get pending() { return buf.length; },
    };
  }
  const util = { clean, isRetail, formatName, makeBurst, BURST_GAP_MS, BURST_MIN };

  if (typeof document === "undefined") { // loaded by the tests
    (typeof globalThis !== "undefined" ? globalThis : this).GTScan = { util };
    return;
  }

  // ---- styles ---------------------------------------------------------------------
  const ICON_SCAN = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V4h3M18 4h3v3M21 17v3h-3M6 20H3v-3"/><path d="M7 8v8M10 8v8M13 8v8M16 8v8"/></svg>';
  const CSS = `
.gtscan-field{display:flex;gap:6px;align-items:stretch;min-width:0;flex:1 1 auto}
.gtscan-field>input{flex:1 1 auto;min-width:0;width:auto}
.gtscan-fieldbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 8px;border-radius:8px;
  border:1px solid var(--line,#343d37);background:var(--surface-2,#252c27);color:var(--ink,#e7ebe6);cursor:pointer}
.gtscan-fieldbtn:hover{border-color:var(--accent,#e2753c);color:var(--accent,#e2753c)}
.gtscan-fieldbtn:focus-visible,.gtscan button:focus-visible,.gtscan input:focus-visible,.gtscan summary:focus-visible{outline:2px solid var(--accent,#e2753c);outline-offset:2px}
body.gtscan-open{overflow:hidden}
.gtscan{position:fixed;inset:0;z-index:1000;background:#0b0d0c;color:#e7ebe6;display:flex;flex-direction:column;
  font-family:var(--f-body,system-ui,sans-serif);font-size:15px;line-height:1.45;
  padding:max(10px,env(safe-area-inset-top,0px)) max(12px,env(safe-area-inset-right,0px)) max(14px,env(safe-area-inset-bottom,0px)) max(12px,env(safe-area-inset-left,0px))}
.gtscan *{box-sizing:border-box}
.gtscan-top{display:flex;align-items:center;justify-content:space-between;gap:8px;max-width:560px;width:100%;margin:0 auto}
.gtscan-top h2{margin:0;font:700 1.1rem var(--f-display,system-ui,sans-serif);letter-spacing:.01em;text-align:center;flex:1}
.gtscan-round{width:44px;height:44px;border-radius:22px;border:0;background:#1e2420;color:#e7ebe6;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.gtscan-round[aria-pressed="true"]{background:#e0a640;color:#1a0f08}
.gtscan-spacer{width:44px;flex:none}
.gtscan-stage{flex:1;min-height:0;max-width:560px;width:100%;margin:10px auto 0;border-radius:14px;overflow:hidden;position:relative;background:#1a1f1c;display:flex;align-items:center;justify-content:center}
.gtscan-stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.gtscan-aim{position:relative;width:min(78%,320px);aspect-ratio:1.7;pointer-events:none}
.gtscan-aim i{position:absolute;width:30px;height:30px;border-color:var(--accent,#e2753c);border-style:solid;border-width:0}
.gtscan-aim i:nth-child(1){left:0;top:0;border-left-width:4px;border-top-width:4px;border-top-left-radius:10px}
.gtscan-aim i:nth-child(2){right:0;top:0;border-right-width:4px;border-top-width:4px;border-top-right-radius:10px}
.gtscan-aim i:nth-child(3){left:0;bottom:0;border-left-width:4px;border-bottom-width:4px;border-bottom-left-radius:10px}
.gtscan-aim i:nth-child(4){right:0;bottom:0;border-right-width:4px;border-bottom-width:4px;border-bottom-right-radius:10px}
.gtscan-aim b{position:absolute;left:12px;right:12px;top:50%;height:2px;background:var(--accent,#e2753c);opacity:.85}
.gtscan-hint{position:absolute;left:12px;right:12px;bottom:14px;text-align:center;font-weight:500;text-shadow:0 1px 3px #000}
.gtscan-bt{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;width:100%}
.gtscan-ring{width:104px;height:104px;border-radius:52px;border:2px solid var(--accent,#e2753c);display:flex;align-items:center;justify-content:center;color:var(--accent,#e2753c);box-shadow:0 0 0 12px rgba(226,117,60,.12)}
.gtscan-ready{font:700 1.3rem var(--f-mono,ui-monospace,monospace);color:var(--accent,#e2753c)}
.gtscan-bt p{margin:0;color:#c9d0ca;max-width:300px}
.gtscan-last{font:500 1rem var(--f-mono,ui-monospace,monospace);background:#1e2420;border:1px solid #343d37;border-radius:8px;padding:8px 12px;min-height:42px;min-width:200px;overflow-wrap:anywhere}
.gtscan-bottom{max-width:560px;width:100%;margin:12px auto 0;display:flex;flex-direction:column;gap:10px}
.gtscan-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;background:#1e2420;border:1px solid #343d37;border-radius:12px;padding:4px}
.gtscan-modes button{min-height:44px;border:0;border-radius:9px;background:transparent;color:#c9d0ca;font:600 .95rem var(--f-mono,ui-monospace,monospace);cursor:pointer}
.gtscan-modes button[aria-checked="true"]{background:var(--accent,#e2753c);color:var(--accent-ink,var(--on-accent,#1a0f08))}
.gtscan-status{min-height:1.45em;margin:0;text-align:center;font-weight:500}
.gtscan-status.ok{color:#6cc48c}.gtscan-status.warn{color:#e0a640}
.gtscan-keep{display:flex;align-items:center;gap:10px;min-height:44px;cursor:pointer;text-transform:none;letter-spacing:0;font:500 15px var(--f-body,system-ui,sans-serif);color:#e7ebe6}
.gtscan-keep input{width:22px;height:22px;accent-color:var(--accent,#e2753c);flex:none}
.gtscan-keep small{display:block;color:#9aa49c;font-size:.85rem}
.gtscan-type{display:flex;gap:8px}
.gtscan-type input{flex:1;min-width:0;min-height:44px;border-radius:8px;border:1px solid #343d37;background:#1e2420;color:#e7ebe6;padding:0 12px;font:500 1rem var(--f-mono,ui-monospace,monospace)}
.gtscan-btn{min-height:44px;border-radius:8px;border:1px solid var(--accent,#e2753c);background:var(--accent,#e2753c);color:var(--accent-ink,var(--on-accent,#1a0f08));font-weight:600;padding:0 16px;cursor:pointer}
.gtscan-link{background:none;border:0;color:var(--accent,#e2753c);font:inherit;font-weight:600;min-height:44px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.gtscan details{background:#1e2420;border:1px solid #343d37;border-radius:10px;padding:10px 12px;color:#c9d0ca;font-size:.9rem;text-align:left;width:100%;max-width:340px}
.gtscan summary{cursor:pointer;color:#e7ebe6;font-weight:600;min-height:28px}
.gtscan ol{margin:6px 0 0;padding-left:20px}
`;
  function addStyles() {
    if (document.getElementById("gtscan-css")) return;
    const s = document.createElement("style"); s.id = "gtscan-css"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---- sounds and buzz -------------------------------------------------------------
  let audio = null;
  function wakeAudio() { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === "suspended") audio.resume(); } catch (e) { audio = null; } }
  function beep(ok) {
    try {
      if (navigator.vibrate) navigator.vibrate(ok === false ? [60, 60, 60] : 70);
      if (!audio) return;
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
      o.frequency.value = ok === false ? 440 : 1200; o.type = "square";
      g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + 0.13);
    } catch (e) { /* no sound is fine */ }
  }

  // ---- the barcode reader ------------------------------------------------------------
  let detectorP = null;
  function getDetector() {
    if (detectorP) return detectorP;
    detectorP = (async () => {
      if ("BarcodeDetector" in window) {
        try {
          const have = await window.BarcodeDetector.getSupportedFormats();
          const fm = FORMATS.filter((f) => have.includes(f));
          if (fm.length) return new window.BarcodeDetector({ formats: fm });
        } catch (e) { /* fall through to the loaded reader */ }
      }
      const mod = await import(FALLBACK_URL);
      return new mod.BarcodeDetector({ formats: FORMATS });
    })();
    detectorP.catch(() => { detectorP = null; }); // try again next time
    return detectorP;
  }

  function getMode() { try { return localStorage.getItem(MODE_KEY) === "bluetooth" ? "bluetooth" : "camera"; } catch (e) { return "camera"; } }
  function setMode(m) { try { localStorage.setItem(MODE_KEY, m); } catch (e) { /* not saved; fine */ } }

  // ---- the scanner screen --------------------------------------------------------------
  let cur = null; // the open scanner, if any

  function open(opts) {
    opts = opts || {};
    if (cur) close();
    addStyles(); wakeAudio();
    const el = document.createElement("div");
    el.className = "gtscan"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "gtscan-title");
    el.innerHTML = `
      <div class="gtscan-top">
        <button type="button" class="gtscan-round" data-x aria-label="Close scanner"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg></button>
        <h2 id="gtscan-title"></h2>
        <button type="button" class="gtscan-round" data-torch aria-label="Flashlight" aria-pressed="false" hidden><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h10l-2 6v12H9V9L7 3z"/><path d="M12 13v2"/></svg></button>
        <span class="gtscan-spacer" data-torchspace></span>
      </div>
      <div class="gtscan-stage" data-stage></div>
      <div class="gtscan-bottom">
        <p class="gtscan-status" data-status aria-live="polite"></p>
        <div class="gtscan-modes" role="radiogroup" aria-label="Scan with">
          <button type="button" role="radio" data-mode="camera">Camera</button>
          <button type="button" role="radio" data-mode="bluetooth">Bluetooth</button>
        </div>
        ${opts.allowKeep ? `<label class="gtscan-keep"><input type="checkbox" data-keep><span>Keep scanning<small>Stay open to scan several in a row</small></span></label>` : ""}
        <div class="gtscan-type" data-typebox hidden><input data-typed aria-label="Barcode or part number" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Barcode or part #"><button type="button" class="gtscan-btn" data-typego>Look up</button></div>
        <button type="button" class="gtscan-link" data-typeopen>Type the code instead</button>
      </div>`;
    el.querySelector("#gtscan-title").textContent = opts.title || "Scan a barcode";
    const q = (s) => el.querySelector(s);
    const s = cur = {
      el, opts, mode: getMode(), stream: null, timer: 0, lastCode: "", lastAt: 0, busy: false,
      burst: makeBurst(), back: document.activeElement, closed: false,
      status(t, kind) { const p = q("[data-status]"); p.textContent = t || ""; p.className = "gtscan-status" + (kind ? " " + kind : ""); },
    };
    document.body.appendChild(el); document.body.classList.add("gtscan-open");

    q("[data-x]").onclick = close;
    el.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => { if (s.mode !== b.dataset.mode) { s.mode = b.dataset.mode; setMode(s.mode); showMode(); } });
    q("[data-typeopen]").onclick = () => { q("[data-typebox]").hidden = false; q("[data-typeopen]").hidden = true; q("[data-typed]").focus(); };
    const typed = () => { const v = clean(q("[data-typed]").value); if (!v) { q("[data-typed]").focus(); return; } q("[data-typed]").value = ""; found(v, "", "typed"); };
    q("[data-typego]").onclick = typed;
    q("[data-typed]").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); typed(); } });
    q("[data-torch]").onclick = toggleTorch;
    s.onKey = (e) => onKey(e);
    document.addEventListener("keydown", s.onKey, true);
    s.onVis = () => { if (document.hidden) stopCamera(); else if (s.mode === "camera" && !s.closed) startCamera(); };
    document.addEventListener("visibilitychange", s.onVis);
    showMode();
    q("[data-x]").focus();
  }

  function showMode() {
    const s = cur; if (!s) return;
    const q = (x) => s.el.querySelector(x);
    s.el.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === s.mode)));
    stopCamera(); s.status("");
    const stage = q("[data-stage]");
    if (s.mode === "camera") {
      stage.innerHTML = `<video playsinline muted aria-label="Camera view"></video><div class="gtscan-aim" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></div><div class="gtscan-hint">Hold the barcode inside the box</div>`;
      startCamera();
    } else {
      stage.innerHTML = `<div class="gtscan-bt">
        <div class="gtscan-ring" aria-hidden="true"><svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10-5 5V2l5 5L7 17"/></svg></div>
        <div class="gtscan-ready">Ready · scan now</div>
        <p>Pull the trigger on your scanner. The code is looked up right away.</p>
        <div class="gtscan-last" data-last aria-label="Last scan">${s.lastCode ? "" : "&nbsp;"}</div>
        <details><summary>First time? Set up the scanner</summary><ol>
          <li>Put the scanner in keyboard (HID) mode. Its manual has a barcode you scan to switch.</li>
          <li>Pair it in your phone's Bluetooth settings.</li>
          <li>Come back here and scan.</li></ol>
          <p style="margin-top:8px;font-size:.85rem">On Android the on-screen keyboard may hide while the scanner is connected. That's normal.</p></details>
      </div>`;
      if (s.lastCode) q("[data-last]").textContent = s.lastCode;
      q("[data-torch]").hidden = true; q("[data-torchspace]").hidden = false;
    }
  }

  async function startCamera() {
    const s = cur; if (!s || s.mode !== "camera" || s.stream) return;
    const video = s.el.querySelector("video"); if (!video) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      s.status("This browser can't use the camera here. Type the code instead, or switch to Bluetooth.", "warn"); return;
    }
    s.status("Starting the camera…");
    let detector;
    try { detector = await getDetector(); } catch (e) {
      if (cur === s) s.status("Couldn't load the barcode reader. Check your connection, or type the code instead.", "warn"); return;
    }
    if (cur !== s || s.mode !== "camera" || s.closed) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      if (cur !== s) return;
      const n = e && e.name;
      s.status(n === "NotAllowedError" || n === "SecurityError"
        ? "The camera is blocked. Allow it for this site (the icon next to the address, or the app's settings), then try again."
        : n === "NotFoundError" || n === "OverconstrainedError" ? "No camera found. Type the code instead, or switch to Bluetooth."
        : "Couldn't start the camera" + (e && e.message ? ": " + e.message : "."), "warn");
      return;
    }
    if (cur !== s || s.mode !== "camera" || s.closed || document.hidden) { stream.getTracks().forEach((t) => t.stop()); return; }
    s.stream = stream; video.srcObject = stream;
    try { await video.play(); } catch (e) { /* autoplay is allowed for a muted inline video */ }
    s.status("");
    // flashlight, when the camera has one
    const track = stream.getVideoTracks()[0];
    let torch = false;
    try { torch = !!(track && track.getCapabilities && track.getCapabilities().torch); } catch (e) { torch = false; }
    s.el.querySelector("[data-torch]").hidden = !torch; s.el.querySelector("[data-torchspace]").hidden = torch;
    s.el.querySelector("[data-torch]").setAttribute("aria-pressed", "false");
    const tick = async () => {
      if (cur !== s || s.stream !== stream) return;
      if (!s.busy && video.readyState >= 2) {
        s.busy = true;
        try {
          const r = await detector.detect(video);
          if (r && r.length && cur === s && s.stream === stream) found(r[0].rawValue, r[0].format, "camera");
        } catch (e) { /* a bad frame; keep going */ }
        s.busy = false;
      }
      if (cur === s && s.stream === stream) s.timer = setTimeout(tick, FRAME_MS);
    };
    tick();
  }

  function stopCamera() {
    const s = cur; if (!s) return;
    clearTimeout(s.timer);
    if (s.stream) { s.stream.getTracks().forEach((t) => t.stop()); s.stream = null; }
    const v = s.el.querySelector("video"); if (v) v.srcObject = null;
  }

  async function toggleTorch() {
    const s = cur; if (!s || !s.stream) return;
    const b = s.el.querySelector("[data-torch]"), on = b.getAttribute("aria-pressed") !== "true";
    try { await s.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] }); b.setAttribute("aria-pressed", String(on)); }
    catch (e) { s.status("Couldn't switch the flashlight.", "warn"); }
  }

  function onKey(e) {
    const s = cur; if (!s) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    const t = e.target;
    if (t && t.matches && t.matches("[data-typed]")) return; // typing in the "type it" box
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Tab" && s.burst.pending === 0) return; // normal Tab moves focus
    const code = s.burst.feed(e.key, e.timeStamp || performance.now());
    if (e.key.length === 1 || code) e.preventDefault();
    if (code) found(code, "", "bluetooth");
  }

  function found(raw, format, via) {
    const s = cur; if (!s) return;
    const text = clean(raw); if (!text) return;
    const now = Date.now();
    if (via === "camera" && text === s.lastCode && now - s.lastAt < REPEAT_MS) return;
    s.lastCode = text; s.lastAt = now;
    const last = s.el.querySelector("[data-last]"); if (last) last.textContent = text;
    const keepBox = s.el.querySelector("[data-keep]");
    const keep = !!(keepBox && keepBox.checked);
    const result = { text, format: format || "", via, formatName: formatName(format, text) };
    if (keep) {
      beep(true);
      let msg = "";
      try { msg = s.opts.onCode ? s.opts.onCode(result, { keep: true }) : ""; } catch (e) { msg = "Something went wrong: " + (e.message || e); }
      s.status(msg || "Scanned " + text, msg && /^not\b/i.test(msg) ? "warn" : "ok");
      return;
    }
    beep(true);
    close();
    if (s.opts.onCode) s.opts.onCode(result, { keep: false });
  }

  function close() {
    const s = cur; if (!s) return;
    stopCamera(); s.closed = true;
    document.removeEventListener("keydown", s.onKey, true);
    document.removeEventListener("visibilitychange", s.onVis);
    s.el.remove(); document.body.classList.remove("gtscan-open");
    cur = null;
    if (s.back && s.back.isConnected && s.back.focus) { try { s.back.focus({ preventScroll: true }); } catch (e) { /* fine */ } }
  }

  // ---- scan buttons on Part # fields ---------------------------------------------------
  function fillField(input) {
    const lab = input.closest("label");
    const name = input.getAttribute("aria-label") || (lab ? lab.textContent.trim() : "") || "Part #";
    open({
      title: "Scan " + name.replace(/\s+/g, " ").slice(0, 40),
      onCode(r) {
        if (!input.isConnected) return;
        input.value = r.text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.focus();
      },
    });
  }
  function enhance(root) {
    (root || document).querySelectorAll("input[data-scan]:not([data-scan-ready])").forEach((input) => {
      input.setAttribute("data-scan-ready", "");
      addStyles();
      const wrap = document.createElement("span"); wrap.className = "gtscan-field";
      input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
      const b = document.createElement("button");
      b.type = "button"; b.className = "gtscan-fieldbtn"; b.innerHTML = ICON_SCAN;
      b.setAttribute("aria-label", "Scan a barcode into " + (input.getAttribute("aria-label") || "this field"));
      b.title = "Scan a barcode";
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fillField(input); });
      wrap.appendChild(b);
    });
  }
  function watch() {
    enhance(document);
    new MutationObserver(() => enhance(document)).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) watch(); else document.addEventListener("DOMContentLoaded", watch);

  window.GTScan = { open, close, enhance, util, ICON: ICON_SCAN, get isOpen() { return !!cur; } };
})();
