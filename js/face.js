// Where the speaker's face is in the main video, so every crop (half screen, the small window, square and wide
// formats, the punch-in) keeps it in frame instead of cutting at a fixed height. MediaPipe's face detector, in the
// browser (~10 MB once, then cached); a handful of frames is enough for someone talking to the camera.
const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
let detector = null;

async function load() {
  if (detector) return detector;
  const { FilesetResolver, FaceDetector } = await import(`${CDN}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  for (const delegate of ["GPU", "CPU"]) {
    try { detector = await FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "IMAGE", minDetectionConfidence: 0.5 }); break; } catch {}
  }
  return detector;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** → { x, y, h } in 0..1 of the frame (centre of the face, its height), or null when no face was found. */
export async function findFace(url, dur, samples = 9) {
  const det = await load();
  if (!det) return null;
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; });
  const s = 320 / Math.max(v.videoWidth, v.videoHeight), c = document.createElement("canvas");
  c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
  const g = c.getContext("2d"), found = [];
  for (let i = 0; i < samples; i++) {
    const t = (dur * (i + 0.5)) / samples;
    await new Promise((res) => { const to = setTimeout(res, 2500); v.onseeked = () => { clearTimeout(to); res(); }; v.currentTime = t; });
    g.drawImage(v, 0, 0, c.width, c.height);
    // The biggest face is the one talking to the camera.
    const best = det.detect(c).detections.map((d) => d.boundingBox).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (best) found.push({ x: (best.originX + best.width / 2) / c.width, y: (best.originY + best.height / 2) / c.height, h: best.height / c.height });
  }
  v.removeAttribute("src"); v.load();
  if (found.length < Math.ceil(samples / 3)) return null;
  return { x: median(found.map((f) => f.x)), y: median(found.map((f) => f.y)), h: median(found.map((f) => f.h)) };
}
