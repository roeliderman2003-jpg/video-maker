// Background music made in the browser: no licence, no download, and the exact BPM is known, so every cut lands on
// the beat. Plus a beat finder for a song the user uploads.

export const STYLES = {
  trap: { name: "טראפ", bpm: 140 },
  boom: { name: "היפ-הופ 90s", bpm: 92 },
  house: { name: "האוס", bpm: 124 },
  afro: { name: "אפרו / רגאטון", bpm: 100 },
  pop: { name: "פופ שמח", bpm: 112 },
  lofi: { name: "לו-פיי רגוע", bpm: 80 },
};

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export async function generateTrack(style, seed, seconds) {
  const sr = 44100, st = STYLES[style] || STYLES.trap;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const rnd = mulberry32(seed * 7919 + style.length * 31);
  const beat = 60 / st.bpm, step = beat / 4, bar = beat * 4;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
  const master = ctx.createGain(); master.gain.value = 0.7;
  master.connect(comp).connect(ctx.destination);
  let bus = master;
  if (style === "lofi") {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3200;
    lp.connect(master); bus = lp;
  }
  // Reverb send
  const ir = ctx.createBuffer(2, sr * 2, sr);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3); }
  const verb = ctx.createConvolver(); verb.buffer = ir;
  const verbGain = ctx.createGain(); verbGain.gain.value = 0.25;
  verb.connect(verbGain).connect(bus);

  const noise = ctx.createBuffer(1, sr, sr);
  { const d = noise.getChannelData(0); for (let i = 0; i < sr; i++) d[i] = Math.random() * 2 - 1; }

  // Every voice is silent until its own note: a gain starts at 1, and anything upstream that is not silent before the
  // note (the 808 shaper) would otherwise sound for the whole track.
  const env = (g, t, peak, a, d) => {
    g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  };
  const noiseHit = (t, type, freq, peak, dec, q = 0.7) => {
    const s = ctx.createBufferSource(); s.buffer = noise; s.loop = dec > 0.4;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); env(g, t, peak, 0.002, dec);
    s.connect(f).connect(g).connect(bus);
    s.start(t, rnd() * 0.5, dec + 0.05);
  };
  const tone = (t, type, f0, f1, peak, a, d, dest = bus, glide = 0.05) => {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
    const g = ctx.createGain(); env(g, t, peak, a, d);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + a + d + 0.05);
    return g;
  };

  const kick = (t, p = 1) => tone(t, "sine", 160, 42, 0.9 * p, 0.002, 0.32, bus, 0.09);
  const k808 = (t, m, d) => {
    const o = ctx.createOscillator(); o.type = "sine";
    o.frequency.setValueAtTime(hz(m) * 2.2, t); o.frequency.exponentialRampToValueAtTime(hz(m), t + 0.06);
    const sh = ctx.createWaveShaper(); const c = new Float32Array(257); // odd length: silence in → exactly 0 out
    for (let i = 0; i < 257; i++) { const x = i / 128 - 1; c[i] = Math.tanh(2.2 * x); }
    sh.curve = c;
    const g = ctx.createGain(); env(g, t, 0.7, 0.003, d);
    o.connect(sh).connect(g).connect(bus); o.start(t); o.stop(t + d + 0.1);
  };
  const snare = (t, p = 1) => { noiseHit(t, "highpass", 1400, 0.45 * p, 0.17); tone(t, "triangle", 190, 160, 0.25 * p, 0.001, 0.08); };
  const clap = (t, p = 1) => { for (const k of [0, 0.011, 0.022]) noiseHit(t + k, "bandpass", 1300, 0.35 * p, k === 0.022 ? 0.16 : 0.02, 1.2); };
  const hat = (t, open = false, p = 1) => noiseHit(t, "highpass", 7500, (open ? 0.16 : 0.11) * p, open ? 0.22 : 0.035);
  const rim = (t) => tone(t, "square", 820, 820, 0.08, 0.001, 0.03);
  const bass = (t, m, d, type = "sawtooth") => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz(m);
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(180, t + d);
    const g = ctx.createGain(); env(g, t, 0.35, 0.005, d);
    o.connect(f).connect(g).connect(bus); o.start(t); o.stop(t + d + 0.05);
  };
  const pad = (t, notes, d, peak = 0.05) => {
    for (const m of notes) for (const det of [-7, 7]) {
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(m); o.detune.value = det;
      const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 1100;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.25);
      g.gain.setValueAtTime(peak, t + d - 0.2); g.gain.linearRampToValueAtTime(0.0001, t + d);
      o.connect(f).connect(g); g.connect(bus); g.connect(verb);
      o.start(t); o.stop(t + d + 0.05);
    }
  };
  const keys = (t, notes, d) => {
    for (const m of notes) {
      const g1 = tone(t, "sine", hz(m), 0, 0.09, 0.01, d);
      g1.connect(verb);
      tone(t, "sine", hz(m) * 2, 0, 0.025, 0.005, d * 0.4);
    }
  };
  const pluck = (t, m, d = 0.25, peak = 0.12) => {
    const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = hz(m);
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(3500, t); f.frequency.exponentialRampToValueAtTime(400, t + d);
    const g = ctx.createGain(); env(g, t, peak, 0.003, d);
    o.connect(f).connect(g); g.connect(bus); g.connect(verb);
    o.start(t); o.stop(t + d + 0.05);
  };
  const bell = (t, m) => { const g = tone(t, "sine", hz(m), 0, 0.12, 0.002, 1.1); g.connect(verb); tone(t, "sine", hz(m) * 2.76, 0, 0.03, 0.002, 0.4); };

  const minor = [0, 2, 3, 5, 7, 8, 10], major = [0, 2, 4, 5, 7, 9, 11];
  const isMajor = style === "pop" || style === "house" || (style === "lofi" && rnd() < 0.5);
  const scale = isMajor ? major : minor;
  const root = 45 + Math.floor(rnd() * 7);
  const progs = isMajor ? [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4]] : [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6], [0, 5, 3, 4]];
  const prog = progs[Math.floor(rnd() * progs.length)];
  const deg = (d, oct = 0) => root + 12 * oct + scale[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  const chord = (d, oct = 1, sev = false) => [deg(d, oct), deg(d + 2, oct), deg(d + 4, oct), ...(sev ? [deg(d + 6, oct)] : [])];
  const motif = Array.from({ length: 16 }, () => (rnd() < 0.45 ? Math.floor(rnd() * 5) * (rnd() < 0.5 ? 1 : 2) % 7 : null));
  const swing = style === "boom" || style === "lofi" ? step * 0.33 : 0;
  const at = (b, s) => b * bar + s * step + (s % 2 ? swing : 0);

  const bars = Math.ceil(seconds / bar) + 1;
  for (let b = 0; b < bars; b++) {
    const intro = b === 0, fill = b % 8 === 7;
    const cd = prog[b % prog.length];
    const tb = b * bar;
    if (style === "trap") {
      pad(tb, chord(cd, 1), bar, 0.035);
      for (let s = 0; s < 16; s += 2) hat(at(b, s));
      if (b % 2 === 1) for (let k = 0; k < 6; k++) hat(at(b, 12) + (k * step * 2) / 3, false, 0.7);
      if (!intro) {
        for (const s of fill ? [0] : [0, 7, 10]) { kick(at(b, s), 0.8); k808(at(b, s), deg(cd, -1), s === 0 ? beat * 1.6 : beat * 0.8); }
        clap(at(b, 8)); snare(at(b, 8), 0.6);
      }
      motif.forEach((n, s) => n !== null && s % 2 === 0 && bell(at(b, s), deg(n, 2)));
    } else if (style === "boom") {
      keys(tb, chord(cd, 1, true), bar * 0.9);
      for (let s = 0; s < 16; s += 2) hat(at(b, s), false, s % 4 ? 0.6 : 1);
      if (!intro) {
        for (const s of [0, 7, 10]) { kick(at(b, s)); bass(at(b, s), deg(cd, -1), beat * 0.9, "triangle"); }
        snare(at(b, 4)); snare(at(b, 12));
        if (fill) snare(at(b, 15), 0.5);
      }
    } else if (style === "house") {
      pad(tb, chord(cd, 1), bar, 0.025);
      for (let s = 0; s < 16; s++) hat(at(b, s), s % 4 === 2, s % 4 === 2 ? 1 : 0.4);
      if (!intro) {
        for (let s = 0; s < 16; s += 4) kick(at(b, s));
        clap(at(b, 4)); clap(at(b, 12));
        for (const s of [2, 6, 10, 14]) bass(at(b, s), deg(cd, -1), step * 1.6);
        for (const s of [3, 10]) for (const m of chord(cd, 1)) pluck(at(b, s), m, 0.18, 0.05);
      }
    } else if (style === "afro") {
      pad(tb, chord(cd, 1), bar, 0.03);
      for (let s = 0; s < 16; s += 2) hat(at(b, s), false, 0.7);
      if (!intro) {
        for (const s of [0, 4, 8, 12]) kick(at(b, s), 0.85);
        for (const s of [3, 6, 11, 14]) { snare(at(b, s), 0.55); rim(at(b, s)); }
        for (const s of [0, 3, 8, 11]) bass(at(b, s), deg(cd, -1), step * 2.5, "sine");
      }
      motif.forEach((n, s) => n !== null && pluck(at(b, s), deg(n, 2), 0.2, 0.08));
    } else if (style === "pop") {
      pad(tb, chord(cd, 1), bar, 0.03);
      for (let s = 0; s < 16; s += 2) hat(at(b, s));
      if (!intro) {
        for (const s of [0, 6, 8]) kick(at(b, s));
        for (const s of [4, 12]) { snare(at(b, s)); clap(at(b, s), 0.6); }
        for (let s = 0; s < 16; s += 2) bass(at(b, s), deg(cd, -1), step * 1.7);
      }
      const ch = chord(cd, 2);
      for (let s = 0; s < 16; s++) pluck(at(b, s), ch[s % 3] + (s % 6 === 5 ? 12 : 0), 0.16, 0.06);
    } else {
      keys(tb, chord(cd, 1, true), bar * 0.95);
      noiseHit(tb, "lowpass", 900, 0.015, bar);
      for (let s = 0; s < 16; s += 2) hat(at(b, s), false, 0.45);
      if (!intro) {
        kick(at(b, 0), 0.7); kick(at(b, 9), 0.6);
        snare(at(b, 4), 0.45); snare(at(b, 12), 0.45);
        bass(at(b, 0), deg(cd, -1), bar * 0.45, "sine");
      }
    }
  }
  const out = await ctx.startRendering();
  // Loudness: bring every style to the same level, with a soft saturation instead of a hard clip on the hits.
  let sum = 0, n = 0;
  for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) sum += d[i] * d[i]; n += d.length; }
  const g = Math.min(4, 0.2 / Math.max(1e-4, Math.sqrt(sum / n)));
  for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * g); }
  return out;
}

/** Tempo and the first beat of an uploaded song (onset autocorrelation over the first minute). */
export function detectBeat(buffer) {
  const sr = buffer.sampleRate, hop = 512, hopSec = hop / sr;
  const d = buffer.getChannelData(0);
  const n = Math.min(Math.floor(d.length / hop), Math.floor(60 / hopSec));
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * hop; j < (i + 1) * hop; j++) s += d[j] * d[j]; e[i] = Math.sqrt(s / hop); }
  const on = new Float32Array(n);
  for (let i = 1; i < n; i++) on[i] = Math.max(0, e[i] - e[i - 1]);
  let best = 120, bestS = -1;
  for (let bpm = 80; bpm <= 165; bpm += 0.5) {
    const lag = 60 / bpm / hopSec;
    let s = 0;
    for (let i = 0; i + 2 * lag < n; i++) s += on[i] * (on[Math.round(i + lag)] + 0.5 * on[Math.round(i + 2 * lag)]);
    if (s > bestS) { bestS = s; best = bpm; }
  }
  const lag = 60 / best / hopSec;
  let off = 0, offS = -1;
  for (let p = 0; p < lag; p++) {
    let s = 0;
    for (let t = p; t < n; t += lag) s += on[Math.round(t)];
    if (s > offS) { offS = s; off = p; }
  }
  return { bpm: best, offset: off * hopSec };
}
