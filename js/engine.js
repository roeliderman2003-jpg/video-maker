// The edit: a plan (what is on screen at every moment, which words, which cuts) and a player that plays the plan on a
// canvas in real time — the same player draws the preview and records the export.

export const ASPECTS = { "9:16": [1080, 1920], "4:5": [1080, 1350], "1:1": [1080, 1080], "16:9": [1920, 1080] };

export const FORMATS = [
  { id: "talk", name: "מדבר + בירולים", desc: "פנים בפתיחה ובסוף, בירולים באמצע", voice: true, video: true, broll: true },
  { id: "hook", name: "פתיחה ואז בירולים", desc: "המשפט הראשון למצלמה, השאר בירולים", voice: true, video: true, broll: true },
  { id: "pip", name: "חלון קטן", desc: "בירולים במסך מלא, אתה בחלון", voice: true, video: true, broll: true },
  { id: "split", name: "חצי מסך", desc: "אתה למעלה, בירולים למטה", voice: true, video: true, broll: true },
  { id: "face", name: "רק מדבר", desc: "חיתוכים וזומים בין משפטים", voice: true, video: true },
  { id: "voice", name: "קול על בירולים", desc: "רק הקול, בלי פנים", voice: true, broll: true },
  { id: "ba", name: "לפני / אחרי על הביט", desc: "בלי דיבור: חשיפות לפני/אחרי", voice: false, pairs: true },
  { id: "montage", name: "מונטאז׳ על הביט", desc: "בלי דיבור: בירולים ולפני/אחרי", voice: false, broll: true },
];

/** Why a format cannot be made from what was uploaded, or null when it can. */
export function formatBlocked(f, A) {
  const media = A.brolls.length + A.pairs.length;
  if (f.voice && !A.main) return "צריך סרטון או הקלטה ראשית";
  if (f.voice && !A.segs.some((s) => s.on)) return "צריך לתמלל ולבחור משפטים";
  if (f.video && !A.main?.isVideo) return "צריך סרטון (לא רק הקלטה)";
  if (f.broll && !media) return "צריך בירולים או לפני/אחרי";
  if (f.pairs && !A.pairs.length) return "צריך זוג לפני/אחרי";
  return null;
}

export const FILTERS = {
  none: "none",
  pop: "contrast(1.12) saturate(1.3)",
  warm: "saturate(1.15) sepia(0.18) contrast(1.05)",
  cool: "saturate(1.05) hue-rotate(-10deg) contrast(1.06)",
  fade: "contrast(0.9) brightness(1.07) saturate(0.85)",
  bw: "grayscale(1) contrast(1.2)",
};

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Selected sentences → pieces of the main recording, back to back. Sentences that follow each other closely in the
 *  recording stay one piece (no needless jump cut). */
export function buildClips(segs, mainDur) {
  const clips = [];
  for (const s of segs) {
    const last = clips.at(-1);
    let a = Math.max(0, s.s0 - 0.06);
    const b = Math.min(mainDur, s.s1 + 0.14);
    if (last && s.s0 >= last.srcEnd - 0.01 && s.s0 - last.srcEnd < 0.3) {
      last.s1 = Math.max(last.s1, b); last.srcEnd = s.s1; last.segs.push(s);
      continue;
    }
    if (last && a < last.s1) a = last.s1;
    if (b - a < 0.2) continue;
    clips.push({ s0: a, s1: b, srcEnd: s.s1, segs: [s] });
  }
  let out = 0;
  for (const c of clips) { c.out0 = out; out += c.s1 - c.s0; c.out1 = out; }
  return clips;
}

function buildWords(clips) {
  const words = [];
  for (const c of clips) for (const s of c.segs) {
    // The transcriber marks a new speaker with «-» and ends sentences with a period; on screen both are noise.
    const toks = (s.text || "").trim().split(/\s+/).map((t) => t.replace(/^[-–—.,…]+|[-–—.,;:…]+$/g, "")).filter(Boolean);
    if (!toks.length) continue;
    const w = toks.map((t) => t.replace(/[^\p{L}\p{N}]/gu, "").length + 2);
    const sum = w.reduce((a, b) => a + b, 0), span = s.s1 - s.s0;
    let acc = 0;
    toks.forEach((t, i) => {
      const a = s.s0 + (span * acc) / sum;
      acc += w[i];
      const b = s.s0 + (span * acc) / sum;
      words.push({ text: iso(t), t0: c.out0 + (a - c.s0), t1: c.out0 + (b - c.s0), seg: s });
    });
  }
  return words;
}

/** Each sentence cut into even pieces: «בן, תגיד | שלום למצלמה», never a lone last word «בן, תגיד שלום | למצלמה». */
function groupWords(words, maxWords, maxChars) {
  const groups = [];
  for (let i = 0; i < words.length;) {
    let j = i;
    while (j < words.length && words[j].seg === words[i].seg) j++;
    const ws = words.slice(i, j);
    for (let k = Math.ceil(ws.length / maxWords); k <= ws.length; k++) {
      const parts = Array.from({ length: k }, (_, n) => ws.slice(Math.round((n * ws.length) / k), Math.round(((n + 1) * ws.length) / k)));
      if (k < ws.length && parts.some((g) => g.reduce((a, w) => a + w.text.length + 1, 0) > maxChars + 1)) continue;
      for (const g of parts) groups.push({ words: g, seg: ws[0].seg });
      break;
    }
    i = j;
  }
  groups.forEach((g, i) => {
    g.t0 = g.words[0].t0;
    const end = g.words.at(-1).t1 + 0.35;
    g.t1 = groups[i + 1] ? Math.min(end, groups[i + 1].words[0].t0) : end;
  });
  return groups;
}

/**
 * p: { format, segs (selected, in order), mainDur, brolls, pairs, target, o (options), bpm }
 * → { voice, total, clips, words, groups, vis: [{ t0, t1, layout, m?, b?, a?, mid? }] }
 */
export function buildPlan(p) {
  const f = FORMATS.find((x) => x.id === p.format);
  const o = p.o, rnd = mulberry32(o.seed * 1009 + p.format.length);
  const beat = 60 / (p.bpm || 120);
  const snap = (t) => Math.round(t / beat) * beat;
  const shotLen = Math.max(1, Math.round(o.pace / beat)) * beat;

  const clips = f.voice ? buildClips(p.segs, p.mainDur) : [];
  const total = f.voice ? clips.at(-1)?.out1 || 0 : p.target;

  const pool = p.brolls.length ? p.brolls : p.pairs.flatMap((x) => [x.after, x.before]);
  let bag = [], last = null;
  const nextSrc = () => {
    if (!bag.length) {
      bag = pool.slice();
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
      if (bag.length > 1 && bag.at(-1) === last) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
    return (last = bag.pop());
  };
  // A phone clip shakes in its first and last moments (the thumb on the button): start a little into it. When the clip
  // was rated (app.js rateClip), the shot comes from its sharp, lit stretches — one of the near-best, at random, so a
  // clip used twice does not show the same seconds twice.
  const inPoint = (src, len) => {
    const room = src.dur - len - 0.1;
    if (room <= 0) return 0;
    const lo = Math.min(0.4, room), hi = lo + Math.max(0, room - 0.8);
    if (src.rating?.length) {
      const cands = [];
      for (let t = lo; t <= hi + 1e-6; t += 0.25) {
        const q = src.rating.filter((r) => r.t >= t && r.t <= t + len).map((r) => r.q);
        if (q.length) cands.push({ t, q: 0.6 * (q.reduce((a, b) => a + b, 0) / q.length) + 0.4 * Math.min(...q) });
      }
      const best = Math.max(...cands.map((x) => x.q)), good = cands.filter((x) => x.q >= best * 0.85);
      if (good.length) return good[Math.floor(rnd() * good.length)].t;
    }
    return lo + rnd() * (hi - lo);
  };
  const req = (src, len, from = null) => ({ src, in: from ?? (src.kind === "video" ? inPoint(src, len) : 0) });
  const brollShots = (a, b, layout) => {
    const cuts = [a];
    for (;;) {
      let n = snap(cuts.at(-1) + shotLen);
      if (n < cuts.at(-1) + 0.6) n = cuts.at(-1) + shotLen;
      if (b - n < 0.7) break;
      cuts.push(n);
    }
    cuts.push(b);
    const out = [];
    for (let i = 0; i < cuts.length - 1; i++) out.push({ t0: cuts[i], t1: cuts[i + 1], layout, m: pool.length ? req(nextSrc(), cuts[i + 1] - cuts[i]) : null });
    return out;
  };
  const baItem = (t0, t1, pair) => ({ t0, t1, layout: "ba", pair, b: req(pair.before, t1 - t0, 0), a: req(pair.after, t1 - t0, 0), mid: Math.min(t1 - 0.4, Math.max(t0 + 0.4, snap(t0 + (t1 - t0) / 2))) });

  let vis = [];
  if (f.voice) {
    const bounds = [0];
    for (const c of clips) for (const s of c.segs) {
      const t = c.out0 + Math.max(0, s.s0 - c.s0);
      if (t - bounds.at(-1) > 0.8 && total - t > 0.8) bounds.push(t);
    }
    bounds.push(total);
    const P = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i], b = bounds[i + 1], k = Math.max(1, Math.round((b - a) / 3.5));
      for (let j = 0; j < k; j++) P.push([a + ((b - a) * j) / k, a + ((b - a) * (j + 1)) / k]);
    }
    const layoutOf = (i) => {
      if (p.format === "face") return "main";
      if (p.format === "voice") return "broll";
      if (i === 0) return "main";
      if (p.format === "hook") return "broll";
      if (p.format === "split" || p.format === "pip") return p.format;
      if (i === P.length - 1 && P.length >= 3) return "main";
      return i % 2 ? "broll" : "main";
    };
    const runs = [];
    P.forEach(([a, b], i) => {
      const L = layoutOf(i), r = runs.at(-1);
      if (r && r.layout === L) r.t1 = b; else runs.push({ t0: a, t1: b, layout: L });
    });
    // Layout changes on the beat when one is near.
    for (let i = 1; i < runs.length; i++) {
      const s = snap(runs[i].t0);
      if (Math.abs(s - runs[i].t0) < beat / 2 && s - runs[i - 1].t0 > 0.6 && runs[i].t1 - s > 0.6) { runs[i].t0 = s; runs[i - 1].t1 = s; }
    }
    for (const r of runs) vis.push(...(r.layout === "main" ? [r] : brollShots(r.t0, r.t1, r.layout)));
  } else if (p.format === "ba") {
    const len = Math.max(2, Math.round(o.baLen / beat)) * beat;
    let t = 0, i = 0;
    while (t < total - 0.5) {
      const t1 = Math.min(total, t + len);
      vis.push(baItem(t, t1, p.pairs[i % p.pairs.length]));
      t = t1;
      if (p.brolls.length && i % 2 === 1 && t < total - 0.5) {
        const t2 = Math.min(total, t + shotLen);
        vis.push({ t0: t, t1: t2, layout: "broll", m: req(nextSrc(), t2 - t) });
        t = t2;
      }
      i++;
    }
    if (vis.length > 1 && vis.at(-1).t1 - vis.at(-1).t0 < 1) { const x = vis.pop(); vis.at(-1).t1 = x.t1; }
  } else {
    vis = brollShots(0, total, "broll");
  }

  // Before/after inside the other formats.
  if (p.format !== "ba" && p.pairs.length && o.baPlace !== "none" && total > 2) {
    const len = Math.min(total, Math.max(2, Math.round(o.baLen / beat)) * beat);
    const items = [];
    // A talking video opens on the face (that is the hook); its before/after comes right after the first shot.
    const first = f.video ? Math.min(total - len, vis.find((v) => v.t0 >= 1.5)?.t0 ?? 0) : 0;
    if (o.baPlace === "start") items.push(baItem(Math.max(0, first), Math.max(0, first) + len, p.pairs[0]));
    else if (o.baPlace === "end") items.push(baItem(Math.max(0, total - len), total, p.pairs[0]));
    else {
      const count = Math.min(p.pairs.length, Math.max(1, Math.floor(total / (len * 3))));
      for (let i = 0; i < count; i++) {
        const t0 = Math.max(0, Math.min(total - len, snap((total * (i + 1)) / (count + 1) - len / 2)));
        items.push(baItem(t0, t0 + len, p.pairs[i]));
      }
    }
    for (const it of items) vis = overlay(vis, it);
  }
  for (const v of vis) for (const r of [v.m, v.a, v.b]) if (r) { r.t0 = v.t0; r.t1 = v.t1; }

  const words = buildWords(clips);
  const groups = o.capStyle === "single" ? groupWords(words, 1, 99) : groupWords(words, o.capStyle === "box" ? 4 : 3, o.capStyle === "box" ? 24 : 18);
  return { voice: f.voice, format: p.format, total, clips, words, groups, vis };
}

function overlay(vis, item) {
  const out = [];
  for (const v of vis) {
    if (v.t1 <= item.t0 || v.t0 >= item.t1) { out.push(v); continue; }
    if (v.t0 < item.t0 - 0.05) out.push({ ...v, t1: item.t0 });
    if (v.t1 > item.t1 + 0.05) {
      const d = item.t1 - v.t0, sh = (r) => r && { ...r, in: r.in + d };
      out.push({ ...v, t0: item.t1, m: sh(v.m), a: sh(v.a), b: sh(v.b) });
    }
  }
  out.push(item);
  return out.sort((a, b) => a.t0 - b.t0);
}

export function pickMime() {
  const c = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}

const reqsOf = (v) => [v.m, v.b, v.a].filter(Boolean);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

export class Player {
  constructor(canvas, stage, audio) {
    this.canvas = canvas;
    this.c = canvas.getContext("2d");
    this.audio = audio;
    this.pool = [];
    for (let i = 0; i < 6; i++) {
      const el = document.createElement("video");
      el.muted = true; el.playsInline = true; el.preload = "auto";
      stage.appendChild(el);
      this.pool.push({ el, req: null });
    }
    this.running = false;
  }

  stop() { this.stopFlag = true; }

  prep(r) {
    if (r.src.kind !== "video" || r.player) return;
    const p = this.pool.find((x) => !x.req);
    if (!p) return;
    p.req = r; r.player = p;
    if (p.el.dataset.src !== r.src.url) { p.el.src = r.src.url; p.el.dataset.src = r.src.url; }
    p.el.currentTime = Math.min(r.in, Math.max(0, (r.src.dur || 0) - 0.05));
    p.el.pause();
  }
  release(r) {
    if (!r.player) return;
    r.player.el.pause(); r.player.req = null; r.player = null;
  }
  upkeep(t, start = true) {
    const vis = this.plan.vis;
    while (this.vi < vis.length && vis[this.vi].t1 <= t) { reqsOf(vis[this.vi]).forEach((r) => this.release(r)); this.vi++; }
    for (let i = this.vi; i < vis.length && vis[i].t0 <= t + 1.5; i++) {
      for (const r of reqsOf(vis[i])) {
        this.prep(r);
        if (start && t >= vis[i].t0 && !r.started && r.player) { r.player.el.play().catch(() => {}); r.started = true; }
      }
    }
  }
  visAt(t) {
    const vis = this.plan.vis;
    for (let i = this.vi; i < vis.length; i++) if (vis[i].t0 <= t && t < vis[i].t1) return vis[i];
    return vis.at(-1);
  }

  /** Plays the plan from the start. record → resolves with the video Blob. */
  async run({ plan, A, o, mains, music, record, monitor, onTime }) {
    if (this.running) this.stop();
    while (this.running) await new Promise((r) => setTimeout(r, 30));
    this.running = true; this.stopFlag = false;
    const [W, H] = ASPECTS[o.aspect];
    this.canvas.width = W; this.canvas.height = H;
    Object.assign(this, { W, H, plan, A, o, vi: 0, act: null, t: 0 });
    this.computeZones();
    for (const p of this.pool) { p.el.pause(); p.req = null; }
    for (const v of plan.vis) for (const r of reqsOf(v)) { r.player = null; r.started = false; }
    const ac = this.audio.ctx;
    await ac.resume();
    this.audio.monitor.gain.value = monitor ? 1 : 0;

    // Everything on screen at 0 is ready before the clock starts.
    const waits = [];
    let ci = 0;
    if (plan.voice) {
      for (const m of mains) m.pause();
      this.act = mains[0];
      waits.push(seekTo(mains[0], plan.clips[0].s0));
      if (plan.clips[1]) mains[1].currentTime = plan.clips[1].s0;
    }
    this.upkeep(0, false);
    for (const p of this.pool) if (p.req) waits.push(ready(p.el));
    await Promise.all(waits);

    let musicSrc = null, musicGain = null;
    if (music) {
      musicSrc = ac.createBufferSource(); musicSrc.buffer = music.buffer; musicSrc.loop = true;
      musicGain = ac.createGain(); musicGain.gain.value = music.gain;
      musicSrc.connect(musicGain).connect(this.audio.master);
    }
    let rec = null;
    const chunks = [];
    if (record) {
      const vs = this.canvas.captureStream(30);
      const stream = new MediaStream([...vs.getVideoTracks(), ...this.audio.dest.stream.getAudioTracks()]);
      rec = new MediaRecorder(stream, { mimeType: o.mime || undefined, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    }
    // The recording starts once the speaker is really moving, not on a still first frame.
    if (plan.voice) { this.act.play().catch(() => {}); await playing(this.act); }
    rec?.start(250);
    this.draw(0);
    const t0 = ac.currentTime;
    musicSrc?.start(t0, music.offset % music.buffer.duration);

    let faded = false;
    await new Promise((resolve) => {
      const tick = () => {
        if (this.stopFlag) return resolve();
        // A phone that has not loaded the next piece of the recording yet stalls the speaker. Recording on would leave a
        // frozen picture and a hole in the voice under running music: hold the recording and the music until it plays.
        const stalled = plan.voice && (this.act.seeking || this.act.readyState < 3) && !this.act.ended;
        if (stalled !== !!this.held) {
          this.held = stalled;
          if (stalled) { if (rec?.state === "recording") rec.pause(); ac.suspend(); }
          else { ac.resume(); if (rec?.state === "paused") rec.resume(); }
        }
        if (stalled) return requestAnimationFrame(tick);
        let t;
        if (plan.voice) {
          let c = plan.clips[ci];
          if (this.act.currentTime >= c.s1 - 0.008 || this.act.ended) {
            this.act.pause();
            if (++ci >= plan.clips.length) return resolve();
            const prev = this.act;
            this.act = mains[ci % 2];
            this.act.play().catch(() => {});
            if (plan.clips[ci + 1]) prev.currentTime = plan.clips[ci + 1].s0;
            c = plan.clips[ci];
          }
          t = c.out0 + Math.max(0, Math.min(c.s1, this.act.currentTime) - c.s0);
          this.ci = ci;
        } else {
          t = ac.currentTime - t0;
          if (t >= plan.total) return resolve();
        }
        this.t = t;
        this.upkeep(t);
        this.draw(t);
        onTime?.(t);
        if (musicGain && !faded && t > plan.total - 0.8) { faded = true; musicGain.gain.setTargetAtTime(0, ac.currentTime, 0.25); }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    if (this.held) { this.held = false; await ac.resume(); }
    for (const m of mains || []) m.pause();
    for (const v of plan.vis) reqsOf(v).forEach((r) => this.release(r));
    let blob = null;
    if (rec) {
      await new Promise((r) => setTimeout(r, 120));
      await new Promise((r) => { rec.onstop = r; rec.stop(); });
      blob = new Blob(chunks, { type: (o.mime || "video/webm").split(";")[0] });
    }
    try { musicSrc?.stop(); } catch {}
    musicSrc?.disconnect();
    this.running = false;
    return this.stopFlag && record ? null : blob;
  }

  // ---------- drawing ----------
  /** Fills the box, cropping what does not fit. With a face (0..1 of the source) the crop keeps it a little above the
   *  middle of the box; without one, centred across and `fy` down. */
  cover(src, sw, sh, x, y, w, h, zoom = 1, fy = 0.5, face = null) {
    if (!sw || !sh) return;
    const c = this.c, s = Math.max(w / sw, h / sh) * zoom, dw = sw * s, dh = sh * s;
    let dx = x + (w - dw) / 2, dy = y + (h - dh) * fy;
    if (face) {
      dx = Math.min(x, Math.max(x + w - dw, x + w * 0.5 - face.x * dw));
      dy = Math.min(y, Math.max(y + h - dh, y + h * 0.45 - face.y * dh));
    }
    c.save();
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    c.drawImage(src, dx, dy, dw, dh);
    c.restore();
  }
  drawMain(x, y, w, h, zoom) {
    const el = this.act;
    if (el && el.readyState >= 2) this.cover(el, el.videoWidth, el.videoHeight, x, y, w, h, zoom, 0.35, this.A.main?.face);
  }
  drawMedia(r, t, x, y, w, h, tz = 1) {
    if (!r) return;
    const prog = clamp01((t - r.t0) / Math.max(0.1, r.t1 - r.t0));
    if (r.src.kind === "image") return this.cover(r.src.img, r.src.w, r.src.h, x, y, w, h, tz * (1 + 0.08 * prog));
    const el = r.player?.el;
    if (el && el.readyState >= 2) this.cover(el, el.videoWidth, el.videoHeight, x, y, w, h, tz * (1 + 0.04 * prog));
  }
  punchAt(t) {
    if (!this.o.punch || !this.plan.voice) return 1;
    return (this.ci || 0) % 2 ? 1.13 : 1;
  }
  round(x, y, w, h, r) { const c = this.c; c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); }

  draw(t) {
    const { c, W, H, o, plan } = this;
    c.save();
    c.fillStyle = "#000"; c.fillRect(0, 0, W, H);
    const v = this.visAt(t);
    c.filter = FILTERS[o.filter] || "none";
    const since = v ? t - v.t0 : 9;
    const tz = o.trans === "zoom" && v && v.t0 > 0 ? 1 + 0.12 * Math.max(0, 1 - since / 0.3) : 1;
    const pz = this.punchAt(t) * tz;
    if (v) {
      if (v.layout === "main") this.drawMain(0, 0, W, H, pz);
      else if (v.layout === "broll") this.drawMedia(v.m, t, 0, 0, W, H, tz);
      else if (v.layout === "split") {
        // Half the screen already crops the face tight: no punch-in here.
        if (H >= W) { this.drawMain(0, 0, W, H / 2, tz); this.drawMedia(v.m, t, 0, H / 2, W, H / 2, tz); }
        else { this.drawMain(W / 2, 0, W / 2, H, tz); this.drawMedia(v.m, t, 0, 0, W / 2, H, tz); }
      } else if (v.layout === "pip") {
        this.drawMedia(v.m, t, 0, 0, W, H, tz);
        const pw = Math.min(W, H) * 0.38, ph = pw * 1.5, x = W * 0.05, y = this.Z.below;
        c.save();
        c.shadowColor = "rgba(0,0,0,.5)"; c.shadowBlur = 30;
        this.round(x - 6, y - 6, pw + 12, ph + 12, 34); c.fillStyle = "#fff"; c.fill();
        c.restore();
        c.save(); this.round(x, y, pw, ph, 28); c.clip(); this.drawMain(x, y, pw, ph, 1); c.restore();
      } else if (v.layout === "ba") this.drawBA(v, t);
    }
    c.filter = "none";
    if (o.trans === "flash" && v && v.t0 > 0 && since < 0.12) { c.fillStyle = `rgba(255,255,255,${0.5 * (1 - since / 0.12)})`; c.fillRect(0, 0, W, H); }
    if (this.Z.title) this.drawTitle();
    if (o.captions && plan.groups.length) this.drawCaptions(t, v);
    if (o.cta && o.ctaText && t >= plan.total - o.ctaLen) this.drawCta(t - (plan.total - o.ctaLen));
    if (this.A.logo) this.drawLogo();
    c.restore();
  }

  drawBA(v, t) {
    const { c, W, H, o } = this;
    const ly = this.Z.below + H * 0.05;
    if (o.baStyle === "side") {
      if (H >= W) {
        this.drawMedia(v.b, t, 0, 0, W, H / 2); this.drawMedia(v.a, t, 0, H / 2, W, H / 2);
        c.fillStyle = "#fff"; c.fillRect(0, H / 2 - 4, W, 8);
        this.label("לפני", W / 2, H * 0.06, false); this.label("אחרי", W / 2, H / 2 + H * 0.06, true);
      } else {
        this.drawMedia(v.b, t, W / 2, 0, W / 2, H); this.drawMedia(v.a, t, 0, 0, W / 2, H);
        c.fillStyle = "#fff"; c.fillRect(W / 2 - 4, 0, 8, H);
        this.label("לפני", W * 0.75, H * 0.1, false); this.label("אחרי", W * 0.25, H * 0.1, true);
      }
      return;
    }
    if (o.baStyle === "flash") {
      const after = t >= v.mid;
      this.drawMedia(after ? v.a : v.b, t, 0, 0, W, H, after ? 1 + 0.08 * Math.max(0, 1 - (t - v.mid) / 0.35) : 1);
      const d = t - v.mid;
      if (d >= 0 && d < 0.2) { c.fillStyle = `rgba(255,255,255,${1 - d / 0.2})`; c.fillRect(0, 0, W, H); }
      this.label(after ? "אחרי" : "לפני", W / 2, ly, after);
      return;
    }
    // wipe: the after reveals from right to left across the middle of the piece
    const wd = Math.min(0.9, (v.t1 - v.t0) * 0.35), frac = ease(clamp01((t - (v.mid - wd / 2)) / wd));
    this.drawMedia(v.b, t, 0, 0, W, H);
    if (frac > 0) {
      const x = W * (1 - frac);
      c.save(); c.beginPath(); c.rect(x, 0, W - x, H); c.clip(); this.drawMedia(v.a, t, 0, 0, W, H); c.restore();
      if (frac < 1) { c.save(); c.shadowColor = "rgba(0,0,0,.6)"; c.shadowBlur = 20; c.fillStyle = "#fff"; c.fillRect(x - 5, 0, 10, H); c.restore(); }
    }
    this.label(frac >= 0.5 ? "אחרי" : "לפני", W / 2, ly, frac >= 0.5);
  }

  label(text, x, y, accent) {
    const { c, W, H, o } = this;
    const size = Math.min(W, H) * 0.075;
    c.save();
    c.font = `900 ${size}px Heebo, Arial, sans-serif`; c.direction = "rtl"; c.textAlign = "center"; c.textBaseline = "middle";
    const w = c.measureText(text).width + size * 1.1;
    c.shadowColor = "rgba(0,0,0,.35)"; c.shadowBlur = 18;
    this.round(x - w / 2, y - size * 0.75, w, size * 1.5, size * 0.75);
    c.fillStyle = accent ? o.capColor : "#fff"; c.fill();
    c.shadowBlur = 0; c.fillStyle = "#111"; c.fillText(text, x, y + size * 0.05);
    c.restore();
  }

  /** Where things go so Instagram/TikTok do not cover them: in 9:16 the top ~10% (header, camera) and the bottom ~20%
   *  (caption, buttons) are theirs. Logo, then title, then everything else below them. */
  computeZones() {
    const { c, W, H, o, A } = this;
    const tall = H / W > 1.7, m = Math.min(W, H) * 0.04;
    const top = tall ? H * 0.105 : m, bottom = tall ? H * 0.2 : m;
    let logo = null;
    if (A.logo) {
      const w = Math.min(W, H) * (o.logoSize / 100), h = (w * A.logo.height) / A.logo.width;
      logo = { w, h, x: o.logoPos.endsWith("r") ? W - w - m : m, y: o.logoPos.startsWith("t") ? top : H - h - bottom };
    }
    let y = top + (logo && o.logoPos.startsWith("t") ? logo.h + H * 0.012 : 0), title = null;
    if (o.title) {
      const size = Math.min(W, H) * 0.058;
      c.save();
      c.font = `800 ${size}px Heebo, Arial, sans-serif`; c.direction = "rtl";
      const lines = wrap(c, o.title, W * 0.84).slice(0, 2).map(iso);
      const bw = Math.max(...lines.map((l) => c.measureText(l).width)) + size, bh = lines.length * size * 1.25 + size * 0.5;
      c.restore();
      title = { y, size, lines, bw, bh };
      y += bh;
    }
    this.Z = { below: y + H * 0.015, logo, title, capBottom: tall ? 0.71 : 0.76 };
  }

  drawTitle() {
    const { c, W } = this, { y, size, lines, bw, bh } = this.Z.title, lh = size * 1.25;
    c.save();
    c.font = `800 ${size}px Heebo, Arial, sans-serif`; c.direction = "rtl"; c.textAlign = "center"; c.textBaseline = "middle";
    this.round(W / 2 - bw / 2, y, bw, bh, size * 0.4); c.fillStyle = "#fff"; c.fill();
    c.fillStyle = "#111";
    lines.forEach((l, i) => c.fillText(l, W / 2, y + size * 0.25 + lh * (i + 0.5)));
    c.restore();
  }

  drawCaptions(t, v) {
    const { c, W, H, o, plan } = this;
    const g = plan.groups.find((x) => x.t0 <= t && t < x.t1);
    if (!g) return;
    const single = o.capStyle === "single";
    let ai = -1;
    g.words.forEach((w, i) => { if (w.t0 <= t) ai = i; });
    const words = g.words;
    const unit = Math.min(W, H * 0.5625);
    let size = (single ? 0.12 : 0.072) * unit * o.capSize;
    let pos = o.capPos;
    if (v?.layout === "split" && pos === "bottom" && H >= W) pos = "middle";
    const y = pos === "top" ? this.Z.below + size : pos === "middle" ? H * 0.5 : H * this.Z.capBottom;
    c.save();
    c.direction = "rtl"; c.textAlign = "left"; c.textBaseline = "middle"; c.lineJoin = "round";
    const font = () => (c.font = `800 ${size}px Heebo, Arial, sans-serif`);
    font();
    let widths = words.map((w) => c.measureText(w.text).width), space = size * 0.3;
    let total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
    if (total > W * 0.8) { size *= (W * 0.8) / total; font(); widths = words.map((w) => c.measureText(w.text).width); space = size * 0.3; total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1); }
    if (single) {
      const w = words[0], pop = 1 + 0.18 * Math.max(0, 1 - (t - w.t0) / 0.12);
      c.translate(W / 2, y); c.scale(pop, pop);
      c.textAlign = "center";
      c.lineWidth = size * 0.2; c.strokeStyle = "#000"; c.strokeText(w.text, 0, 0);
      c.fillStyle = o.capColor; c.fillText(w.text, 0, 0);
      c.restore();
      return;
    }
    if (o.capStyle === "box") {
      const pad = size * 0.45;
      this.round(W / 2 - total / 2 - pad, y - size * 0.8, total + pad * 2, size * 1.6, size * 0.35);
      c.fillStyle = "rgba(0,0,0,.62)"; c.fill();
    }
    let x = W / 2 + total / 2;
    words.forEach((w, i) => {
      x -= widths[i];
      const active = i === ai;
      if (o.capStyle === "box") {
        if (active) { this.round(x - size * 0.12, y - size * 0.62, widths[i] + size * 0.24, size * 1.24, size * 0.2); c.fillStyle = o.capColor; c.fill(); }
        c.fillStyle = active ? "#111" : "#fff"; c.fillText(w.text, x, y);
      } else {
        c.lineWidth = size * 0.2; c.strokeStyle = "#000"; c.strokeText(w.text, x, y);
        c.fillStyle = active ? o.capColor : "#fff"; c.fillText(w.text, x, y);
      }
      x -= space;
    });
    c.restore();
  }

  drawCta(dt) {
    const { c, W, H, o } = this;
    const k = ease(clamp01(dt / 0.35)), unit = Math.min(W, H * 0.5625);
    // Below the face and the small window, above the captions.
    const s1 = unit * 0.078, s2 = unit * 0.056, y = H * (H / W > 1.7 ? 0.585 : 0.55) + (1 - k) * 60;
    c.save();
    c.globalAlpha = k; c.direction = "rtl"; c.textAlign = "center"; c.textBaseline = "middle";
    c.font = `900 ${s1}px Heebo, Arial, sans-serif`;
    const w1 = c.measureText(iso(o.ctaText)).width;
    c.font = `700 ${s2}px Heebo, Arial, sans-serif`;
    const w2 = o.ctaSub ? c.measureText(iso(o.ctaSub)).width : 0;
    const bw = Math.min(W * 0.92, Math.max(w1, w2) + unit * 0.12), bh = s1 * 1.5 + (o.ctaSub ? s2 * 1.6 : 0) + unit * 0.05;
    c.shadowColor = "rgba(0,0,0,.45)"; c.shadowBlur = 30;
    this.round(W / 2 - bw / 2, y - bh / 2, bw, bh, unit * 0.04); c.fillStyle = "rgba(10,10,14,.86)"; c.fill();
    c.shadowBlur = 0;
    c.fillStyle = "#fff"; c.font = `900 ${s1}px Heebo, Arial, sans-serif`;
    c.fillText(iso(o.ctaText), W / 2, y - (o.ctaSub ? s2 * 0.75 : 0));
    if (o.ctaSub) { c.fillStyle = o.capColor; c.font = `700 ${s2}px Heebo, Arial, sans-serif`; c.fillText(iso(o.ctaSub), W / 2, y + s1 * 0.75); }
    c.restore();
  }

  drawLogo() {
    const { c, W, H, o, A } = this;
    const { x, y, w, h } = this.Z.logo;
    c.save(); c.globalAlpha = o.logoOpacity / 100; c.drawImage(A.logo, x, y, w, h); c.restore();
  }
}

/** Latin runs (handles, phone numbers, English) kept left-to-right inside the Hebrew line: «@barber», not «barber@». */
const iso = (s) => String(s || "").replace(/[A-Za-z0-9@#][A-Za-z0-9@#._\-+:/']*(?: [A-Za-z0-9@#][A-Za-z0-9@#._\-+:/']*)*/g, (m) => "\u2066" + m + "\u2069");

function wrap(c, text, maxW) {
  const words = text.split(/\s+/), lines = [];
  let line = "";
  for (const w of words) {
    const tryL = line ? line + " " + w : w;
    if (c.measureText(tryL).width > maxW && line) { lines.push(line); line = w; } else line = tryL;
  }
  if (line) lines.push(line);
  return lines;
}

function seekTo(el, t) {
  return new Promise((res) => {
    const done = () => { el.removeEventListener("seeked", done); clearTimeout(to); res(); };
    const to = setTimeout(done, 4000);
    el.addEventListener("seeked", done);
    el.currentTime = t;
  });
}
function playing(el) {
  if (!el.paused && el.readyState >= 3) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { el.removeEventListener("playing", done); clearTimeout(to); res(); };
    const to = setTimeout(done, 1500);
    el.addEventListener("playing", done);
  });
}
function ready(el) {
  if (el.readyState >= 2 && !el.seeking) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { el.removeEventListener("seeked", done); el.removeEventListener("loadeddata", done); clearTimeout(to); res(); };
    const to = setTimeout(done, 4000);
    el.addEventListener("seeked", done); el.addEventListener("loadeddata", done);
  });
}
