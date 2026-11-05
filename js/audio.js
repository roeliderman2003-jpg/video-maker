// Audio helpers: decode to 16 kHz mono for the transcriber, frame energy, speech detection, and fitting a length.

export const SR = 16000;
export const HOP = 0.02; // 20 ms energy frames

export async function decodeTo16k(file) {
  const buf = await file.arrayBuffer();
  // An OfflineAudioContext resamples whatever it decodes to its own rate.
  const ctx = new OfflineAudioContext(1, SR, SR);
  const ab = await ctx.decodeAudioData(buf);
  const n = ab.length, out = new Float32Array(n), ch = ab.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

export function rmsFrames(a) {
  const h = Math.round(SR * HOP), n = Math.floor(a.length / h), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * h, e = j + h; j < e; j++) s += a[j] * a[j];
    r[i] = Math.sqrt(s / h);
  }
  return r;
}

export function speechThreshold(r) {
  const s = Array.from(r).sort((a, b) => a - b);
  const floor = s[Math.floor(s.length * 0.15)] || 0;
  const peak = s[Math.floor(s.length * 0.95)] || 0.1;
  return Math.max(0.004, floor + (peak - floor) * 0.1);
}

/** Cut points for the transcriber: pieces of at most 28 s, each cut at the quietest moment between 18 and 28 s. */
export function chunkBounds(r) {
  const total = r.length * HOP, bounds = [0];
  while (total - bounds.at(-1) > 28) {
    const a = Math.floor((bounds.at(-1) + 18) / HOP), b = Math.floor((bounds.at(-1) + 28) / HOP);
    let best = b, bestE = Infinity;
    for (let i = a; i < b - 15; i++) {
      let e = 0;
      for (let j = i; j < i + 15; j++) e += r[j];
      if (e < bestE) { bestE = e; best = i + 7; }
    }
    bounds.push(best * HOP);
  }
  bounds.push(total);
  return bounds;
}

/** Moves each segment's edges onto the actual speech: trims silence inside, and reaches a little outside when the
 *  transcriber started late or stopped early. */
export function tighten(segs, r, thr) {
  const f = (t) => Math.max(0, Math.min(r.length - 1, Math.round(t / HOP)));
  const loud = (i) => r[i] >= thr;
  for (const s of segs) {
    let a = f(s.s0), b = f(s.s1);
    if (b - a < 3) continue;
    const a0 = a, b0 = b;
    while (a < b - 10 && !loud(a)) a++;
    while (b > a + 10 && !loud(b)) b--;
    if (a === a0) { let k = 0; while (a > 0 && loud(a - 1) && k++ < 15) a--; }
    if (b === b0) { let k = 0; while (b < r.length - 1 && loud(b + 1) && k++ < 20) b++; }
    s.s0 = a * HOP; s.s1 = (b + 1) * HOP;
  }
  // No overlaps after reaching outward.
  for (let i = 1; i < segs.length; i++) if (segs[i].s0 < segs[i - 1].s1) segs[i].s0 = segs[i - 1].s1;
  return segs.filter((s) => s.s1 - s.s0 > 0.25);
}

/** Speech regions without a transcript (the «no transcription» path): split at pauses, long ones at their quietest. */
export function vadSegments(r, thr) {
  const segs = [];
  let start = -1, quiet = 0;
  for (let i = 0; i < r.length; i++) {
    if (r[i] >= thr) { if (start < 0) start = i; quiet = 0; }
    else if (start >= 0 && ++quiet > 17) { segs.push([start, i - quiet + 1]); start = -1; quiet = 0; }
  }
  if (start >= 0) segs.push([start, r.length]);
  const out = [];
  for (let [a, b] of segs) {
    while (b - a > 400) { // > 8 s
      let best = a + 250, bestE = Infinity;
      for (let i = a + 150; i < a + 400; i++) if (r[i] < bestE) { bestE = r[i]; best = i; }
      out.push([a, best]); a = best;
    }
    out.push([a, b]);
  }
  return out.filter(([a, b]) => b - a >= 20).map(([a, b]) => ({ s0: a * HOP, s1: b * HOP, text: "" }));
}

const FILLERS = /^(אה+|אמ+|אממ+|אהה+|כאילו|יעני|אוקיי|[.,?!\s…-])*$/;
export const isFiller = (s) => !s.text.trim() ? false : FILLERS.test(s.text.trim());

const ends = (s) => /[.?!…]["'״]?$/.test(s.text.trim());

/** Picks the sentences for the target length. First choice: one stretch of sentences that follow each other, starting
 *  where a thought starts and ending where one ends — sentences picked from all over a recording to fill the seconds
 *  open mid-thought and jump between subjects. Only when no stretch fills the length well, the best fill from anywhere
 *  (always the first sentence, the last when it fits). Never over the target by more than half a second. */
export function autoSelect(segs, target) {
  segs.forEach((s) => (s.on = !isFiller(s) && s.s1 - s.s0 >= 0.4));
  if (!target) return;
  const idx = segs.map((s, i) => i).filter((i) => segs[i].on);
  const dur = (i) => segs[i].s1 - segs[i].s0 + 0.2;
  const sum = idx.reduce((a, i) => a + dur(i), 0);
  if (sum <= target + 0.5 || !idx.length) return;

  const texts = segs.some((s) => s.text.trim());
  const opens = (i) => i === idx[0] || !texts || ends(segs[i - 1]);
  const closes = (i) => !texts || ends(segs[i]);
  let run = null;
  for (let a = 0; a < idx.length; a++) {
    let len = 0;
    for (let b = a; b < idx.length && len + dur(idx[b]) <= target + 0.5; b++) {
      len += dur(idx[b]);
      const score = len / target + (opens(idx[a]) ? 0.15 : 0) + (closes(idx[b]) ? 0.15 : 0) + (a === 0 ? 0.05 : 0);
      if (!run || score > run.score) run = { a, b, len, score };
    }
  }
  if (run && run.len >= target * 0.7) {
    const keep = new Set(idx.slice(run.a, run.b + 1));
    segs.forEach((s, i) => (s.on = keep.has(i)));
    return;
  }
  const U = 10, cap = Math.round((target + 0.5) * U);
  const solve = (forced) => {
    const base = forced.reduce((a, i) => a + Math.round(dur(i) * U), 0);
    if (base > cap) return null;
    const free = idx.filter((i) => !forced.includes(i));
    const W = cap - base, best = new Int32Array(W + 1).fill(-1), from = [];
    best[0] = 0;
    for (let k = 0; k < free.length; k++) {
      const w = Math.round(dur(free[k]) * U), took = new Uint8Array(W + 1);
      for (let c = W; c >= w; c--) if (best[c - w] >= 0 && best[c - w] + w > best[c]) { best[c] = best[c - w] + w; took[c] = 1; }
      from.push(took);
    }
    let c = 0;
    for (let x = 0; x <= W; x++) if (best[x] > best[c]) c = x;
    const chosen = new Set(forced);
    for (let k = free.length - 1; k >= 0; k--) if (from[k][c]) { chosen.add(free[k]); c -= Math.round(dur(free[k]) * U); }
    return chosen;
  };
  const first = idx[0], last = idx.at(-1);
  const chosen = solve(first === last ? [first] : [first, last]) || solve([first]) || new Set([first]);
  segs.forEach((s, i) => (s.on = chosen.has(i)));
}

export const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
