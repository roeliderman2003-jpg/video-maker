import { SR, decodeTo16k, rmsFrames, speechThreshold, chunkBounds, tighten, vadSegments, autoSelect, fmtTime } from "./audio.js";
import { ASPECTS, FORMATS, formatBlocked, buildPlan, pickMime, Player } from "./engine.js";
import { STYLES, generateTrack, detectBeat } from "./music.js";
import { defragment } from "./mp4fix.js";
import { findFace } from "./face.js";

const $ = (id) => document.getElementById(id);

// ---------- settings (remembered in this browser) ----------
const DEFAULTS = {
  target: 30, formats: ["talk", "pip", "ba"], aspect: "9:16", previewFormat: "talk",
  captions: true, capStyle: "classic", capPos: "bottom", capSize: 1, capColor: "#ffc83d", title: "",
  musicMode: "gen", musicStyle: "trap", musicSeed: 1, musicVol: 30,
  baPlace: "start", baStyle: "wipe", baLen: 3,
  pace: 2, trans: "flash", punch: true, filter: "none", seed: 1,
  cta: true, ctaText: "לקביעת תור", ctaSub: "", ctaLen: 3,
  logoPos: "tr", logoSize: 16, logoOpacity: 100, quality: "fast",
};
let S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem("vm-settings") || "{}")); } catch {}
const save = () => { try { localStorage.setItem("vm-settings", JSON.stringify(S)); } catch {} };

// ---------- uploaded material ----------
const A = { main: null, brolls: [], pairs: [], logo: null, segs: [], music: null };
let mains = null; // two <video> elements of the main recording, wired into the audio graph
let audio = null, player = null, worker = null, workerReady = false, workerDevice = "";
const stage = $("stage");

function ensureAudio() {
  if (audio) return audio;
  const ctx = new AudioContext();
  const master = ctx.createGain(), monitor = ctx.createGain(), dest = ctx.createMediaStreamDestination();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
  master.connect(limiter);
  limiter.connect(monitor).connect(ctx.destination);
  limiter.connect(dest);
  // The voice chain: a phone recording comes out thin and uneven — cut the rumble, even it out, bring it to one level.
  const voiceIn = ctx.createGain(), hp = ctx.createBiquadFilter(), comp = ctx.createDynamicsCompressor(), voiceGain = ctx.createGain();
  hp.type = "highpass"; hp.frequency.value = 85;
  comp.threshold.value = -24; comp.ratio.value = 3; comp.knee.value = 8; comp.attack.value = 0.004; comp.release.value = 0.18;
  voiceIn.connect(hp).connect(comp).connect(voiceGain).connect(master);
  audio = { ctx, master, monitor, dest, voiceIn, voiceGain };
  player = new Player($("cv"), stage, audio);
  return audio;
}

function toast(msg, bad = false, ms = 4500) {
  const t = $("toast");
  t.textContent = msg; t.classList.toggle("bad", bad); t.classList.remove("hidden");
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add("hidden"), ms);
}

async function loadMedia(file) {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)) {
    const img = new Image(); img.src = url;
    try { await new Promise((res, rej) => { img.onload = res; img.onerror = rej; if (img.complete && img.naturalWidth) res(); }); } catch { throw new Error(/hei[cf]/i.test(file.name + file.type) ? `${file.name}: תמונת HEIC של אייפון לא נפתחת בדפדפן. שמור אותה כ-JPG.` : `${file.name}: התמונה לא נפתחה`); }
    return { kind: "image", url, img, w: img.naturalWidth, h: img.naturalHeight, dur: 0, name: file.name, file };
  }
  const v = document.createElement("video");
  v.preload = "auto"; v.muted = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.src = url;
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error(`${file.name}: הקובץ לא נפתח בדפדפן`)); });
  if (!isFinite(v.duration)) { v.currentTime = 1e9; await new Promise((r) => (v.ondurationchange = r)); }
  const m = { kind: v.videoWidth ? "video" : "audio", url, dur: v.duration, w: v.videoWidth, h: v.videoHeight, name: file.name, file };
  if (m.kind === "video") m.poster = await posterOf(v, Math.min(0.5, m.dur / 2));
  return m;
}

/** A still for the thumbnail: iPhone Safari draws no frame for a <video> that has not played. */
async function posterOf(v, t) {
  try {
    await new Promise((res) => { const to = setTimeout(res, 2500); v.onseeked = () => { clearTimeout(to); res(); }; v.currentTime = t; });
    const c = document.createElement("canvas"), s = 240 / Math.max(v.videoWidth, v.videoHeight);
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  } catch { return ""; }
}

// ---------- step 1: files ----------
$("inMain").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const m = await loadMedia(f);
    if (m.kind === "image") throw new Error("הקובץ הראשי צריך להיות סרטון או הקלטה");
    A.main = { ...m, isVideo: m.kind === "video" };
    A.segs = []; A.audio16 = null;
    const { ctx, voiceIn } = ensureAudio();
    mains?.forEach((el) => el.remove());
    mains = [0, 1].map(() => {
      const el = document.createElement("video");
      el.playsInline = true; el.setAttribute("playsinline", ""); el.preload = "auto"; el.src = m.url;
      stage.appendChild(el);
      ctx.createMediaElementSource(el).connect(voiceIn);
      return el;
    });
    $("mainInfo").innerHTML = `<b>${esc(f.name)}</b> · ${fmtTime(m.dur)} · ${A.main.isVideo ? `${m.w}×${m.h}` : "הקלטה"}`;
    // In the background: until it answers (or if it finds nobody) the crops stay where they always were.
    if (A.main.isVideo) findFace(m.url, m.dur).then((face) => { if (A.main?.url === m.url) A.main.face = face; }).catch((e) => console.warn("face detection:", e));
    $("btnAsr").disabled = false; $("btnSkipAsr").disabled = false;
    $("segBox").classList.add("hidden");
  } catch (err) { toast(err.message, true); }
  refresh();
};

/** How usable each half second of a b-roll is: sharp (a phone swung around blurs whole seconds) and lit enough. The
 *  edit takes its shots from the good stretches; until this has run (in the background) it picks at random. */
async function rateClip(m) {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = m.url;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
  const W = 144, H = Math.max(2, Math.round((W * m.h) / m.w)), c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true }), L = new Float32Array(W * H), out = [];
  for (let t = 0.25; t < m.dur - 0.1; t += 0.5) {
    await new Promise((res) => { const to = setTimeout(res, 2500); v.onseeked = () => { clearTimeout(to); res(); }; v.currentTime = t; });
    g.drawImage(v, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let lum = 0, edge = 0;
    for (let i = 0; i < W * H; i++) { L[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]; lum += L[i]; }
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; edge += Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - W] - L[i + W]); }
    out.push({ t, lum: lum / (W * H), edge });
  }
  v.removeAttribute("src"); v.load();
  const top = Math.max(1e-6, ...out.map((o) => o.edge));
  m.rating = out.map((o) => ({ t: o.t, q: (o.edge / top) * Math.min(1, o.lum / 70) }));
}
let rating = Promise.resolve();
const rate = (m) => (rating = rating.then(() => rateClip(m)).catch((e) => console.warn("b-roll rating:", e)));

$("inBroll").onchange = async (e) => {
  for (const f of e.target.files) {
    try { const m = await loadMedia(f); if (m.kind !== "audio") { A.brolls.push(m); if (m.kind === "video") rate(m); } } catch (err) { toast(err.message, true); }
  }
  e.target.value = "";
  renderBrolls(); refresh();
};

function thumbEl(m) {
  return m.kind === "image" ? `<img src="${m.url}" alt="">` : m.poster ? `<img src="${m.poster}" alt="">` : `<video src="${m.url}#t=0.5" muted playsinline preload="metadata"></video>`;
}
function renderBrolls() {
  $("brollList").innerHTML = A.brolls.map((m, i) => `<div class="thumb">${thumbEl(m)}<button class="x" data-i="${i}" title="הסר">✕</button>${m.kind === "video" ? `<span class="tag">${m.dur.toFixed(1)}״</span>` : ""}</div>`).join("");
  $("brollList").querySelectorAll(".x").forEach((b) => (b.onclick = () => { A.brolls.splice(+b.dataset.i, 1); renderBrolls(); refresh(); }));
}

function renderPairs() {
  $("pairList").innerHTML = A.pairs.map((p, i) => `
    <div class="pair">
      ${["before", "after"].map((side) => `<label class="slot">${p[side] ? thumbEl(p[side]) : side === "before" ? "בחר «לפני»" : "בחר «אחרי»"}
        <span class="cap ${side === "before" ? "b" : ""}">${side === "before" ? "לפני" : "אחרי"}</span>
        <input type="file" accept="video/*,image/*" data-i="${i}" data-side="${side}"></label>`).join("")}
      <button class="btn ghost" data-del="${i}" title="הסר זוג">✕</button>
    </div>`).join("");
  $("pairList").querySelectorAll("input[type=file]").forEach((inp) => (inp.onchange = async () => {
    try { A.pairs[+inp.dataset.i][inp.dataset.side] = await loadMedia(inp.files[0]); } catch (err) { toast(err.message, true); }
    renderPairs(); refresh();
  }));
  $("pairList").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { A.pairs.splice(+b.dataset.del, 1); renderPairs(); refresh(); }));
}
$("addPair").onclick = () => { A.pairs.push({ before: null, after: null }); renderPairs(); };
$("inPairsBulk").onchange = async (e) => {
  const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name, "he", { numeric: true }));
  for (let i = 0; i + 1 < files.length; i += 2) {
    try { A.pairs.push({ before: await loadMedia(files[i]), after: await loadMedia(files[i + 1]) }); } catch (err) { toast(err.message, true); }
  }
  if (files.length % 2) toast("נשאר קובץ אחד בלי זוג, והוא לא נכנס.");
  e.target.value = "";
  renderPairs(); refresh();
};
const readyPairs = () => A.pairs.filter((p) => p.before && p.after);

// Drag & drop on the main drop zone
const dz = $("dropMain");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => { dz.classList.remove("over"); });

// ---------- step 2: words ----------
function postWorker(msg) { worker.postMessage(msg); }
function ensureWorker() {
  if (worker) return;
  worker = new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" });
}

async function decodeMain() {
  if (A.audio16) return;
  setProg("asrProg", 0, "מכין את האודיו…");
  A.audio16 = await decodeTo16k(A.main.file);
  A.rms = rmsFrames(A.audio16);
  A.thr = speechThreshold(A.rms);
}

$("btnAsr").onclick = async () => {
  if (!A.main) return;
  $("btnAsr").disabled = $("btnSkipAsr").disabled = true;
  try {
    await decodeMain();
    ensureWorker();
    const files = {};
    let resolveReady, rejectReady;
    const readyP = new Promise((r, j) => { resolveReady = r; rejectReady = j; });
    let pending = null;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress" && m.file && m.total) {
        files[m.file] = [m.loaded || 0, m.total];
        const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
        setProg("asrProg", (l / t) * 100, `מוריד מודל עברית (פעם אחת): ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB`);
      } else if (m.type === "ready") { workerReady = true; workerDevice = m.device; resolveReady(m.device); }
      else if (m.type === "result") pending?.res(m);
      else if (m.type === "error") { if (pending) pending.rej(new Error(m.message)); else rejectReady(new Error(m.message)); }
    };
    if (!workerReady) {
      // A phone that runs out of memory loading the model reloads the page; the mark tells the next load what happened.
      try { localStorage.setItem("vm-asr-loading", "1"); } catch {}
      // The model is half a gigabyte: ask the browser not to clear it when the phone runs low on space.
      navigator.storage?.persist?.().catch(() => {});
      postWorker({ type: "load", quality: S.quality, cpu: new URLSearchParams(location.search).has("cpu") });
      setProg("asrProg", 0, "טוען את מודל התמלול…");
      await readyP;
      try { localStorage.removeItem("vm-asr-loading"); } catch {}
    }
    const run = (audio) => new Promise((res, rej) => { pending = { res, rej }; postWorker({ type: "run", id: Date.now(), audio }); });
    const b = chunkBounds(A.rms), segs = [];
    const started = performance.now();
    for (let i = 0; i < b.length - 1; i++) {
      const eta = i ? ` · עוד בערך ${Math.ceil(((performance.now() - started) / i) * (b.length - 1 - i) / 1000)} שניות` : "";
      const slow = workerDevice === "wasm" ? " · רץ על המעבד, זה איטי" : "";
      setProg("asrProg", (i / (b.length - 1)) * 100, `מתמלל ${fmtTime(b[i])} מתוך ${fmtTime(b.at(-1))}${eta}${slow}`);
      const f0 = Math.floor(b[i] / 0.02), f1 = Math.floor(b[i + 1] / 0.02);
      let loud = 0;
      for (let k = f0; k < f1; k++) if (A.rms[k] >= A.thr) loud++;
      if (loud < 15) continue; // under 0.3 s of speech: whisper would only invent words here
      const chunk = A.audio16.subarray(Math.floor(b[i] * SR), Math.floor(b[i + 1] * SR));
      const r = await run(chunk);
      const len = b[i + 1] - b[i];
      if (r.chunks.length) for (const ch of r.chunks) {
        const text = (ch.text || "").trim();
        if (!text) continue;
        const [a, z] = ch.timestamp || [];
        segs.push({ s0: b[i] + (a ?? 0), s1: b[i] + Math.min(len, z ?? len), text });
      } else if (r.text?.trim()) segs.push({ s0: b[i], s1: b[i + 1], text: r.text.trim() });
    }
    A.segs = tighten(segs, A.rms, A.thr);
    if (!A.segs.length) throw new Error("לא נמצא דיבור בסרטון");
    autoSelect(A.segs, S.target);
    setProg("asrProg", 100, `תומלל: ${A.segs.length} משפטים`);
    renderSegs();
  } catch (err) {
    console.error(err);
    setProg("asrProg", 0, "התמלול נכשל: " + err.message);
    toast("התמלול נכשל. אפשר ללחוץ «בלי תמלול» ולהמשיך בלי כתוביות.", true, 8000);
  }
  $("btnAsr").disabled = $("btnSkipAsr").disabled = false;
  refresh();
};

$("btnSkipAsr").onclick = async () => {
  if (!A.main) return;
  try {
    await decodeMain();
    A.segs = vadSegments(A.rms, A.thr);
    if (!A.segs.length) throw new Error("לא נמצא דיבור בסרטון");
    autoSelect(A.segs, S.target);
    setProg("asrProg", 100, `נמצאו ${A.segs.length} קטעי דיבור. רוצה כתוביות? הקלד את הטקסט בכל קטע למטה`);
    renderSegs(); refresh();
  } catch (err) { toast(err.message, true); }
};

function setProg(id, pct, text) {
  const el = $(id);
  el.classList.remove("hidden");
  el.querySelector("i").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  el.querySelector(".ptext").textContent = text;
}

const listenEl = document.createElement("audio");
let listenStop = 0;
listenEl.ontimeupdate = () => { if (listenEl.currentTime >= listenStop) listenEl.pause(); };

function renderSegs() {
  $("segBox").classList.toggle("hidden", !A.segs.length);
  $("segList").innerHTML = A.segs.map((s, i) => `
    <div class="seg ${s.on ? "" : "off"}" data-i="${i}">
      <input type="checkbox" ${s.on ? "checked" : ""}>
      <span class="t">${fmtTime(s.s0)} · ${(s.s1 - s.s0).toFixed(1)}״</span>
      <input type="text" value="${esc(s.text)}" placeholder="(בלי טקסט)">
      <button class="play" title="השמע">▶</button>
    </div>`).join("");
  $("segList").querySelectorAll(".seg").forEach((row) => {
    const s = A.segs[+row.dataset.i];
    row.querySelector("input[type=checkbox]").onchange = (e) => { s.on = e.target.checked; row.classList.toggle("off", !s.on); updateSum(); refresh(); };
    row.querySelector("input[type=text]").oninput = (e) => { s.text = e.target.value; };
    row.querySelector(".play").onclick = () => {
      if (listenEl.src !== A.main.url) listenEl.src = A.main.url;
      listenEl.currentTime = s.s0; listenStop = s.s1; listenEl.play();
    };
  });
  updateSum();
}
function updateSum() {
  const sel = A.segs.filter((s) => s.on), dur = sel.reduce((a, s) => a + (s.s1 - s.s0) + 0.2, 0);
  const over = S.target && dur > S.target + 1;
  $("segSum").innerHTML = `נבחרו ${sel.length} משפטים · <span class="${over ? "over" : ""}">${dur.toFixed(1)} שניות</span>${S.target ? ` מתוך ${S.target}` : ""}`;
}
$("btnAuto").onclick = () => { autoSelect(A.segs, S.target); renderSegs(); refresh(); };
$("btnAll").onclick = () => { A.segs.forEach((s) => (s.on = true)); renderSegs(); refresh(); };

// ---------- step 3: style ----------
function chips(id, key, options, after) {
  const el = $(id);
  const draw = () => {
    el.innerHTML = options.map(([v, label]) => `<button class="chip ${S[key] === v ? "on" : ""}" data-v="${v}">${label}</button>`).join("");
    el.querySelectorAll(".chip").forEach((b) => (b.onclick = () => {
      const v = options.find((o) => String(o[0]) === b.dataset.v)[0];
      S[key] = v; save(); draw(); after?.(); refresh();
    }));
  };
  draw();
}
function bindInput(id, key, kind = "value", after) {
  const el = $(id);
  el[kind === "checked" ? "checked" : "value"] = S[key];
  el.addEventListener(kind === "checked" ? "change" : "input", () => {
    const v = kind === "checked" ? el.checked : el.type === "range" ? +el.value : el.value;
    S[key] = v; save(); after?.(); refresh();
  });
}

chips("chTarget", "target", [[15, "15 שניות"], [30, "30"], [45, "45"], [60, "60"], [90, "90"], [0, "בלי הגבלה"]], () => {
  if (A.segs.length) { autoSelect(A.segs, S.target); renderSegs(); }
});
chips("chAspect", "aspect", [["9:16", "ריל / סטורי 9:16"], ["4:5", "פיד 4:5"], ["1:1", "ריבוע"], ["16:9", "רוחב 16:9"]]);
chips("chCapStyle", "capStyle", [["classic", "קלאסי"], ["box", "בתוך מלבן"], ["single", "מילה אחת גדולה"]]);
chips("chCapPos", "capPos", [["bottom", "למטה"], ["middle", "באמצע"], ["top", "למעלה"]]);
chips("chMusicMode", "musicMode", [["gen", "מוזיקה מוכנה"], ["file", "שיר שלי"], ["none", "בלי מוזיקה"]], musicModeUI);
chips("chMusicStyle", "musicStyle", Object.entries(STYLES).map(([k, v]) => [k, v.name]));
chips("chBaPlace", "baPlace", [["start", "בהתחלה"], ["mix", "לאורך הסרטון"], ["end", "בסוף"], ["none", "בלי"]]);
chips("chBaStyle", "baStyle", [["wipe", "וילון"], ["flash", "הבזק על הביט"], ["side", "צד ליד צד"]]);
chips("chTrans", "trans", [["cut", "חיתוך חד"], ["flash", "הבזק"], ["zoom", "זום"]]);
chips("chFilter", "filter", [["none", "בלי פילטר"], ["pop", "חי"], ["warm", "חם"], ["cool", "קר"], ["fade", "דהוי"], ["bw", "שחור-לבן"]]);
chips("chLogoPos", "logoPos", [["tr", "ימין למעלה"], ["tl", "שמאל למעלה"], ["br", "ימין למטה"], ["bl", "שמאל למטה"]]);
bindInput("tgCaptions", "captions", "checked");
bindInput("rgCapSize", "capSize");
bindInput("inCapColor", "capColor");
bindInput("inTitle", "title");
bindInput("rgMusicVol", "musicVol");
bindInput("rgBaLen", "baLen", "value", () => ($("baLenVal").textContent = S.baLen + "״"));
bindInput("rgPace", "pace", "value", () => ($("paceVal").textContent = S.pace + "״"));
bindInput("tgPunch", "punch", "checked");
bindInput("tgCta", "cta", "checked");
bindInput("inCtaText", "ctaText");
bindInput("inCtaSub", "ctaSub");
bindInput("rgCtaLen", "ctaLen", "value", () => ($("ctaLenVal").textContent = S.ctaLen + "״"));
bindInput("rgLogoSize", "logoSize");
bindInput("rgLogoOp", "logoOpacity");
$("selQuality").value = S.quality;
$("selQuality").onchange = (e) => { S.quality = e.target.value; save(); };
$("baLenVal").textContent = S.baLen + "״"; $("paceVal").textContent = S.pace + "״"; $("ctaLenVal").textContent = S.ctaLen + "״";
$("btnShuffle").onclick = () => { S.seed++; save(); toast("הבירולים עורבבו מחדש"); refresh(); };
$("btnMusicShuffle").onclick = () => { S.musicSeed++; save(); toast("מנגינה חדשה"); musicListen(); };

function musicModeUI() {
  $("musicGen").classList.toggle("hidden", S.musicMode !== "gen");
  $("musicFile").classList.toggle("hidden", S.musicMode !== "file");
}
musicModeUI();

$("inMusic").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const { ctx } = ensureAudio();
    const buffer = await ctx.decodeAudioData(await f.arrayBuffer());
    const beat = detectBeat(buffer);
    A.music = { buffer, ...beat, name: f.name };
    $("musicInfo").innerHTML = `<b>${esc(f.name)}</b> · ${fmtTime(buffer.duration)} · ${Math.round(beat.bpm)} BPM`;
  } catch { toast("השיר לא נפתח. נסה MP3 או M4A.", true); }
  refresh();
};

$("inLogo").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { const m = await loadMedia(f); A.logo = m.img; $("btnLogoRemove").classList.remove("hidden"); } catch (err) { toast(err.message, true); }
  refresh();
};
$("btnLogoRemove").onclick = () => { A.logo = null; $("inLogo").value = ""; $("btnLogoRemove").classList.add("hidden"); refresh(); };

// ---------- music ----------
const musicCache = new Map();
function bpmNow() {
  if (S.musicMode === "gen") return STYLES[S.musicStyle].bpm;
  if (S.musicMode === "file" && A.music) return A.music.bpm;
  return 120;
}
async function musicFor(seconds, voice) {
  const vol = S.musicVol / 100;
  if (S.musicMode === "none" || vol === 0) return null;
  const gain = voice ? vol * 0.36 : Math.min(1.2, vol * 3);
  if (S.musicMode === "file") return A.music ? { buffer: A.music.buffer, offset: A.music.offset, gain } : null;
  const len = Math.ceil(seconds / 10) * 10 + 10;
  const key = `${S.musicStyle}|${S.musicSeed}|${len}`;
  if (!musicCache.has(key)) musicCache.set(key, generateTrack(S.musicStyle, S.musicSeed, len));
  return { buffer: await musicCache.get(key), offset: 0, gain };
}
let listenSrc = null;
async function musicListen() {
  const { ctx } = ensureAudio();
  await ctx.resume();
  try { listenSrc?.stop(); } catch {}
  const m = await musicFor(12, false);
  if (!m) return;
  listenSrc = ctx.createBufferSource(); listenSrc.buffer = m.buffer;
  const g = ctx.createGain(); g.gain.value = 0.8;
  listenSrc.connect(g).connect(ctx.destination);
  listenSrc.start(0, 0, 10);
}
$("btnMusicListen").onclick = musicListen;

// ---------- formats, preview, export ----------
function renderFormats() {
  $("fmtList").innerHTML = FORMATS.map((f) => {
    const why = formatBlocked(f, { ...A, pairs: readyPairs() });
    const on = S.formats.includes(f.id);
    return `<label class="fmt ${on ? "on" : ""} ${why ? "off" : ""}"><input type="checkbox" data-id="${f.id}" ${on ? "checked" : ""}>
      <span><b>${f.name}</b><small>${f.desc}</small>${why ? `<em>${why}</em>` : ""}</span></label>`;
  }).join("");
  $("fmtList").querySelectorAll("input").forEach((inp) => (inp.onchange = () => {
    S.formats = inp.checked ? [...new Set([...S.formats, inp.dataset.id])] : S.formats.filter((x) => x !== inp.dataset.id);
    save(); refresh();
  }));
}
let previewPinned = false;
function usableFormats() { return FORMATS.filter((f) => !formatBlocked(f, { ...A, pairs: readyPairs() })); }

function renderPreviewChips() {
  const ok = usableFormats();
  if (ok.length && (!previewPinned || !ok.some((f) => f.id === S.previewFormat))) S.previewFormat = (ok.find((f) => S.formats.includes(f.id)) || ok[0]).id;
  $("chPreview").innerHTML = ok.map((f) => `<button class="chip ${S.previewFormat === f.id ? "on" : ""}" data-v="${f.id}">${f.name}</button>`).join("");
  $("chPreview").querySelectorAll(".chip").forEach((b) => (b.onclick = () => { S.previewFormat = b.dataset.v; previewPinned = true; save(); renderPreviewChips(); }));
  $("phEmpty").classList.toggle("hidden", ok.length > 0);
  $("btnPlay").disabled = !ok.length;
  const exp = S.formats.filter((id) => ok.some((f) => f.id === id));
  $("btnExport").disabled = !exp.length || exporting;
  $("btnExport").textContent = exp.length ? `צור ${exp.length === 1 ? "סרטון אחד" : `${exp.length} סרטונים`}` : A.main && !A.segs.length && S.formats.some((id) => FORMATS.find((f) => f.id === id)?.voice) ? "קודם לחץ «תמלל» (שלב 2)" : ok.length ? "סמן גרסה אחת לפחות" : "העלה חומרים קודם";
  $("mExport").disabled = $("btnExport").disabled; $("mExport").textContent = exporting ? "מייצא…" : $("btnExport").textContent;
  $("mPreview").disabled = !ok.length;
}

function refresh() { renderFormats(); renderPreviewChips(); updateSum(); }

function makePlan(format) {
  const f = FORMATS.find((x) => x.id === format);
  return buildPlan({
    format, segs: A.segs.filter((s) => s.on), mainDur: A.main?.dur || 0,
    brolls: A.brolls, pairs: readyPairs(), target: S.target || 30,
    o: S, bpm: bpmNow(),
  });
}
const opts = () => ({ ...S, mime: pickMime() });

/** iPhone plays a video with sound only from a tap: start every main element inside the tap itself, before any await. */
function unlock() {
  const { ctx, monitor } = ensureAudio();
  monitor.gain.value = 0;
  ctx.resume();
  // The b-roll players too: in Low Power Mode an iPhone will not start even a muted video without a tap.
  for (const el of [...(mains || []), ...player.pool.map((p) => p.el)]) { el.play().catch(() => {}); el.pause(); }
}
/** The selected speech brought to one level, whatever the phone recorded: with the music the video lands near -14 LUFS,
 *  where Instagram and TikTok play it, with peaks under -1 dB. */
function setVoiceLevel() {
  if (!A.rms || !audio) return;
  let s = 0, n = 0;
  for (const seg of A.segs) if (seg.on) for (let i = Math.floor(seg.s0 / 0.02); i < Math.min(A.rms.length, seg.s1 / 0.02); i++) { s += A.rms[i] ** 2; n++; }
  const rms = n ? Math.sqrt(s / n) : 0.12;
  audio.voiceGain.gain.value = Math.max(0.5, Math.min(6, 0.08 / Math.max(rms, 1e-3)));
}

async function fontsReady() {
  try { await Promise.all([document.fonts.load("800 40px Heebo"), document.fonts.load("900 40px Heebo"), document.fonts.load("700 40px Heebo")]); } catch {}
}

$("btnPlay").onclick = async () => {
  unlock();
  setVoiceLevel();
  try {
    await fontsReady();
    const plan = makePlan(S.previewFormat);
    if (!plan.total) return toast("אין מה לנגן: בחר משפטים", true);
    const music = await musicFor(plan.total, plan.voice);
    $("phEmpty").classList.add("hidden");
    await player.run({ plan, A, o: opts(), mains, music, record: false, monitor: true, onTime: (t) => ($("tTime").textContent = `${fmtTime(t)} / ${fmtTime(plan.total)}`) });
  } catch (err) { console.error(err); toast("התצוגה נכשלה: " + err.message, true); }
};
$("btnStop").onclick = () => player?.stop();
$("mPreview").onclick = () => { $("cv").scrollIntoView({ behavior: "smooth", block: "center" }); if (player?.running && !exporting) player.stop(); else $("btnPlay").click(); };
$("mExport").onclick = () => { $("cv").scrollIntoView({ behavior: "smooth", block: "center" }); $("btnExport").click(); };

let exporting = false, wake = null;
$("btnExport").onclick = async () => {
  const list = S.formats.filter((id) => usableFormats().some((f) => f.id === id));
  if (!list.length) return;
  unlock();
  setVoiceLevel();
  exporting = true; refresh();
  try { wake = await navigator.wakeLock?.request("screen"); } catch {}
  const mime = pickMime();
  if (!mime) { toast("הדפדפן הזה לא יודע להקליט וידאו. נסה כרום במחשב.", true, 8000); exporting = false; refresh(); return; }
  await fontsReady();
  try {
    for (let i = 0; i < list.length; i++) {
      const id = list[i], f = FORMATS.find((x) => x.id === id);
      const plan = makePlan(id);
      if (!plan.total) continue;
      const music = await musicFor(plan.total, plan.voice);
      const head = `גרסה ${i + 1} מתוך ${list.length}: ${f.name}`;
      setProg("expProg", 0, head);
      let blob = null;
      for (;;) {
        hiddenAbort = false;
        blob = await player.run({
          plan, A, o: { ...opts(), mime }, mains, music, record: true, monitor: false,
          onTime: (t) => { setProg("expProg", (t / plan.total) * 100, `${head} · ${fmtTime(t)} / ${fmtTime(plan.total)}`); $("tTime").textContent = `${fmtTime(t)} / ${fmtTime(plan.total)}`; },
        });
        if (blob || !hiddenAbort) break;
        // The browser stops drawing a tab in the background, so that take is spoiled: start this version again.
        setProg("expProg", 0, `${head} · נעצר כי יצאת מהדף. יתחיל מחדש כשתחזור לכאן`);
        while (document.hidden) await new Promise((r) => setTimeout(r, 300));
      }
      if (!blob) break;
      if (mime.startsWith("video/mp4")) {
        try {
          const fixed = defragment(new Uint8Array(await blob.arrayBuffer()));
          if (fixed) blob = new Blob([fixed], { type: "video/mp4" });
        } catch (e) { console.warn("MP4 rebuild failed; keeping the recorder's file", e); }
      }
      addResult(blob, f, plan.total, mime);
    }
    setProg("expProg", 100, "מוכן ✓ הסרטונים למטה");
  } catch (err) {
    console.error(err);
    toast("הייצוא נכשל: " + err.message, true, 8000);
  }
  try { await wake?.release(); } catch {}
  exporting = false; refresh();
};

function addResult(blob, f, total, mime) {
  const url = URL.createObjectURL(blob);
  const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
  const name = `${f.name.replace(/[\s/׳]+/g, "-")}-${Math.round(total)}s-${S.aspect.replace(":", "x")}.${ext}`;
  const el = document.createElement("div");
  el.className = "result";
  el.innerHTML = `<video src="${url}" controls playsinline></video>
    <div><b>${f.name}</b><small>${Math.round(total)} שניות · ${S.aspect} · ${(blob.size / 1e6).toFixed(1)}MB${ext === "webm" ? " · WEBM (לאינסטגרם עדיף כרום חדש שמוציא MP4)" : ""}</small>
    <div class="row"><button class="btn primary share hidden">📲 שמור לגלריה / שתף</button><a class="btn ghost" href="${url}" download="${name}">⬇ הורדה</a></div></div>`;
  // On a phone the share sheet is the way to the gallery, Instagram and WhatsApp; a download lands in «Files».
  const file = new File([blob], name, { type: mime.split(";")[0] });
  const share = el.querySelector(".share");
  if (navigator.canShare?.({ files: [file] })) {
    share.classList.remove("hidden");
    share.onclick = () => navigator.share({ files: [file] }).catch((e) => e.name !== "AbortError" && toast("השיתוף לא הצליח. נסה «הורדה».", true));
  }
  $("results").prepend(el);
}

let hiddenAbort = false;
document.addEventListener("visibilitychange", () => {
  if (!document.hidden || !player?.running) return;
  if (exporting) { hiddenAbort = true; toast("הייצוא נעצר כי יצאת מהדף (אפליקציה אחרת או מסך כבוי). כשתחזור הוא יתחיל שוב את הגרסה הזו.", true, 10000); }
  player.stop();
});

const isPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
try {
  if (localStorage.getItem("vm-asr-loading")) {
    localStorage.removeItem("vm-asr-loading");
    $("asrWarn").textContent = "בפעם הקודמת הטלפון לא הצליח לטעון את התמלול והדף נטען מחדש. אפשר לנסות שוב (לסגור קודם אפליקציות אחרות), או ללחוץ «בלי תמלול» ולקבל סרטונים בלי כתוביות.";
    $("asrWarn").classList.remove("hidden");
  }
} catch {}
if (isPhone) $("asrPhone").classList.remove("hidden");
// Samsung Internet (a Galaxy's default browser) often has no WebGPU and an older recorder: the same page in Chrome is
// fast and makes MP4. Chrome is on every Galaxy, and an intent link opens this page there.
// Without WebGPU the transcriber runs on the processor: minutes per sentence on a phone. Say so before he waits.
(async () => {
  let gpu = false;
  try { gpu = !!(await navigator.gpu?.requestAdapter()); } catch {}
  if (gpu && !new URLSearchParams(location.search).has("cpu")) return;
  $("asrNoGpu").classList.remove("hidden");
  $("btnAsr").textContent = "תמלל בכל זאת (איטי)";
  $("btnAsr").classList.replace("primary", "ghost");
  $("btnSkipAsr").classList.replace("ghost", "primary");
  const inChrome = /Chrome\/\d/.test(navigator.userAgent) && !/SamsungBrowser|EdgA?|OPR|Firefox/i.test(navigator.userAgent);
  if (inChrome) $("asrNoGpu").textContent = "⚠️ המכשיר הזה לא תומך בתמלול מהיר, ובו התמלול יהיה איטי מאוד (10 דקות ומעלה). עדיף «בלי תמלול» ולהקליד את הכתוביות בעצמך, או לתמלל מהמחשב.";
})();
if (/SamsungBrowser/i.test(navigator.userAgent)) {
  $("chromeLink").href = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(location.href)};end`;
  $("samsungBar").classList.remove("hidden");
}

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

// ---------- local test hook: ?demo loads files listed in demo/manifest.json (not deployed) ----------
if (new URLSearchParams(location.search).has("demo")) {
  (async () => {
    const q = new URLSearchParams(location.search), dir = "demo/" + (q.get("demo") ? q.get("demo") + "/" : "");
    const man = await (await fetch(dir + "manifest.json")).json();
    if (q.get("main")) man.main = q.get("main");
    const file = async (p) => { const r = await fetch(dir + p); const b = await r.blob(); return new File([b], p.split("/").pop(), { type: b.type }); };
    const setFiles = async (id, paths) => { const dt = new DataTransfer(); for (const p of paths) dt.items.add(await file(p)); $(id).files = dt.files; await $(id).onchange({ target: $(id) }); };
    if (man.main) await setFiles("inMain", [man.main]);
    if (man.brolls) await setFiles("inBroll", man.brolls);
    if (man.pairs) await setFiles("inPairsBulk", man.pairs);
    if (man.logo) await setFiles("inLogo", [man.logo]);
    window.__demo = { A, S };
  })();
}

refresh();
