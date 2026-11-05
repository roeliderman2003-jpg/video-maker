// MediaRecorder writes a fragmented MP4: an empty index (duration 0) and the frames in moof/mdat pieces. Players cope,
// but gallery apps, WhatsApp and the Instagram uploader may show 0:00 or refuse it. This rebuilds the same frames into
// a plain MP4 — one full index (moov) at the start, then one mdat — without re-encoding anything.

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex", "moof", "traf", "udta"]);

function parse(buf, start = 0, end = buf.length) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = dv.getUint32(i), hdr = 8;
    const type = String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]);
    if (size === 1) { size = Number(dv.getBigUint64(i + 8)); hdr = 16; }
    else if (size === 0) size = end - i;
    if (size < hdr || i + size > end) break;
    const box = { type, start: i, size, hdr, data: buf.subarray(i + hdr, i + size) };
    if (CONTAINERS.has(type)) box.kids = parse(buf, i + hdr, i + size);
    out.push(box);
    i += size;
  }
  return out;
}
const find = (boxes, type) => boxes?.find((b) => b.type === type);
const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

function box(type, ...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(8 + len);
  view(out).setUint32(0, 8 + len);
  for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u32s(values, head = []) {
  const out = new Uint8Array(4 * (head.length + values.length)), dv = view(out);
  [...head, ...values].forEach((v, k) => dv.setUint32(4 * k, v >>> 0));
  return out;
}
/** A box with its duration field rewritten (mvhd / tkhd / mdhd, version 0 or 1). */
function withDuration(b, offV0, offV1, dur) {
  const d = b.data.slice(), dv = view(d);
  if (d[0] === 1) dv.setBigUint64(offV1, BigInt(Math.round(dur)));
  else dv.setUint32(offV0, Math.min(0xffffffff, Math.round(dur)));
  return box(b.type, d);
}
const raw = (b) => box(b.type, b.data);
function rebuild(b, map) {
  if (map[b.type] !== undefined) return map[b.type];
  if (!b.kids) return raw(b);
  return box(b.type, ...b.kids.map((k) => rebuild(k, map)).filter(Boolean));
}

export function defragment(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const top = parse(buf);
  const moov = find(top, "moov");
  if (!moov || !top.some((b) => b.type === "moof")) return null; // already a plain MP4

  const mvhd = find(moov.kids, "mvhd"), movieScale = view(mvhd.data).getUint32(mvhd.data[0] === 1 ? 20 : 12);
  const trex = {};
  for (const t of find(moov.kids, "mvex")?.kids || []) if (t.type === "trex") {
    const dv = view(t.data);
    trex[dv.getUint32(4)] = { dur: dv.getUint32(12), size: dv.getUint32(16), flags: dv.getUint32(20) };
  }
  const tracks = {};
  for (const trak of moov.kids.filter((b) => b.type === "trak")) {
    const tkhd = find(trak.kids, "tkhd"), id = view(tkhd.data).getUint32(tkhd.data[0] === 1 ? 20 : 12);
    const mdia = find(trak.kids, "mdia"), mdhd = find(mdia.kids, "mdhd");
    const scale = view(mdhd.data).getUint32(mdhd.data[0] === 1 ? 20 : 12);
    const hdlr = find(mdia.kids, "hdlr"), handler = String.fromCharCode(...hdlr.data.subarray(8, 12));
    tracks[id] = { trak, id, scale, handler, samples: [] };
  }

  // Every sample of every fragment: where its bytes are, how long it lasts, whether it is a keyframe.
  for (const moof of top.filter((b) => b.type === "moof")) {
    for (const traf of moof.kids.filter((b) => b.type === "traf")) {
      const tfhd = find(traf.kids, "tfhd"), dv = view(tfhd.data), tf = dv.getUint32(0) & 0xffffff, id = dv.getUint32(4);
      const tr = tracks[id], dflt = trex[id] || { dur: 0, size: 0, flags: 0 };
      if (!tr) continue;
      let o = 8, base = moof.start, dDur = dflt.dur, dSize = dflt.size, dFlags = dflt.flags;
      if (tf & 0x1) { base = Number(dv.getBigUint64(o)); o += 8; }
      if (tf & 0x2) o += 4;
      if (tf & 0x8) { dDur = dv.getUint32(o); o += 4; }
      if (tf & 0x10) { dSize = dv.getUint32(o); o += 4; }
      if (tf & 0x20) { dFlags = dv.getUint32(o); o += 4; }
      for (const trun of traf.kids.filter((b) => b.type === "trun")) {
        const t = view(trun.data), ver = trun.data[0], fl = t.getUint32(0) & 0xffffff, n = t.getUint32(4);
        let p = 8, pos = base;
        if (fl & 0x1) { pos = base + t.getInt32(p); p += 4; }
        let first = null;
        if (fl & 0x4) { first = t.getUint32(p); p += 4; }
        for (let k = 0; k < n; k++) {
          const dur = fl & 0x100 ? t.getUint32((p += 4) - 4) : dDur;
          const size = fl & 0x200 ? t.getUint32((p += 4) - 4) : dSize;
          let flags = fl & 0x400 ? t.getUint32((p += 4) - 4) : dFlags;
          if (k === 0 && first !== null) flags = first;
          const cto = fl & 0x800 ? (ver ? t.getInt32((p += 4) - 4) : t.getUint32((p += 4) - 4)) : 0;
          tr.samples.push({ pos, size, dur, cto, sync: !((flags >> 16) & 1) });
          pos += size;
        }
      }
    }
  }

  // The recorder sometimes stamps two frames with the same time (duration 0). Some apps reject a timeline that does not
  // move forward, so each such frame gets one tick, taken back from the next frames that can spare it.
  for (const tr of Object.values(tracks)) {
    let debt = 0;
    for (const s of tr.samples) {
      if (s.dur === 0) { s.dur = 1; debt++; }
      else if (debt && s.dur > 1) { const take = Math.min(debt, s.dur - 1); s.dur -= take; debt -= take; }
    }
  }

  // The new file: ftyp, moov (full index), mdat (the same bytes, in the order they were recorded).
  const order = Object.values(tracks).flatMap((tr) => tr.samples.map((s) => ({ s, tr }))).sort((a, b) => a.s.pos - b.s.pos);
  const mdatLen = order.reduce((a, x) => a + x.s.size, 0);
  const build = (mdatStart) => {
    let off = mdatStart;
    for (const { s } of order) { s.out = off; off += s.size; }
    let movieDur = 0;
    const traks = Object.values(tracks).map((tr) => {
      const S = tr.samples, durTrack = S.reduce((a, s) => a + s.dur, 0), durMovie = (durTrack * movieScale) / tr.scale;
      movieDur = Math.max(movieDur, durMovie);
      const stts = [];
      for (const s of S) { const l = stts.at(-1); if (l && l[1] === s.dur) l[0]++; else stts.push([1, s.dur]); }
      const parts = [
        raw(find(find(find(find(tr.trak.kids, "mdia").kids, "minf").kids, "stbl").kids, "stsd")),
        box("stts", u32s(stts.flat(), [0, stts.length])),
      ];
      if (S.some((s) => s.cto)) {
        const ctts = [];
        for (const s of S) { const l = ctts.at(-1); if (l && l[1] === s.cto) l[0]++; else ctts.push([1, s.cto]); }
        parts.push(box("ctts", u32s(ctts.flat(), [0x01000000, ctts.length])));
      }
      if (tr.handler === "vide" && S.some((s) => !s.sync)) {
        const ss = S.map((s, k) => (s.sync ? k + 1 : 0)).filter(Boolean);
        parts.push(box("stss", u32s(ss, [0, ss.length])));
      }
      parts.push(box("stsc", u32s([1, 1, 1], [0, 1])));
      parts.push(box("stsz", u32s(S.map((s) => s.size), [0, 0, S.length])));
      const co = new Uint8Array(8 + 8 * S.length), cv = view(co);
      cv.setUint32(4, S.length);
      S.forEach((s, k) => cv.setBigUint64(8 + 8 * k, BigInt(s.out)));
      parts.push(box("co64", co));
      return rebuild(tr.trak, {
        stbl: box("stbl", ...parts),
        tkhd: withDuration(find(tr.trak.kids, "tkhd"), 20, 28, durMovie),
        mdhd: withDuration(find(find(tr.trak.kids, "mdia").kids, "mdhd"), 16, 24, durTrack),
      });
    });
    const other = moov.kids.filter((b) => !["mvhd", "trak", "mvex"].includes(b.type)).map(raw);
    return box("moov", withDuration(mvhd, 16, 24, movieDur), ...traks, ...other);
  };
  const ftyp = box("ftyp", new Uint8Array([105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 105, 115, 111, 50, 97, 118, 99, 49, 109, 112, 52, 49])); // isom, isom iso2 avc1 mp41
  const moovLen = build(0).length; // the offsets do not change its size (co64)
  const mdatStart = ftyp.length + moovLen + 8;
  const newMoov = build(mdatStart);
  const out = new Uint8Array(mdatStart + mdatLen);
  out.set(ftyp, 0); out.set(newMoov, ftyp.length);
  view(out).setUint32(ftyp.length + moovLen, 8 + mdatLen);
  out.set([109, 100, 97, 116], ftyp.length + moovLen + 4); // "mdat"
  for (const { s } of order) out.set(buf.subarray(s.pos, s.pos + s.size), s.out);
  return out;
}
