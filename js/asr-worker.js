// Hebrew transcription in the browser: ivrit-ai's whisper-large-v3-turbo (ONNX) through transformers.js.
// The model downloads once (~0.5-1.5 GB) and the browser keeps it; nothing is sent anywhere.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5";

env.allowLocalModels = false;

// The browser cache refuses the 370 MB encoder ("Unexpected internal error"), so the model downloaded again on every
// visit. The site's private file system holds it; the ".ok" mark is written last, so a cut-off download is not reused.
const fileCache = {
  dir: async () => (await navigator.storage.getDirectory()).getDirectoryHandle("models", { create: true }),
  name: (key) => String(key).replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_"),
  async match(key) {
    try {
      const d = await fileCache.dir(), n = fileCache.name(key);
      await d.getFileHandle(n + ".ok");
      const f = await (await d.getFileHandle(n)).getFile();
      return new Response(f, { headers: { "content-length": String(f.size) } });
    } catch { return undefined; }
  },
  async put(key, response) {
    try {
      const d = await fileCache.dir(), n = fileCache.name(key);
      await response.body.pipeTo(await (await d.getFileHandle(n, { create: true })).createWritable());
      await (await (await d.getFileHandle(n + ".ok", { create: true })).createWritable()).close();
    } catch (e) { console.warn("model not saved, it will download again next time:", e); }
  },
};
if (self.navigator.storage?.getDirectory && self.FileSystemFileHandle?.prototype.createWritable) {
  env.useBrowserCache = false; env.useCustomCache = true; env.customCache = fileCache;
}

const MODEL = "ivrit-ai/whisper-large-v3-turbo-onnx";
let asr = null;

async function pickDevice(quality, cpu) {
  try {
    if (cpu) throw 0;
    const ad = self.navigator.gpu && (await self.navigator.gpu.requestAdapter());
    if (ad) {
      if (ad.features.has("shader-f16")) {
        return { device: "webgpu", dtype: quality === "best" ? { encoder_model: "fp16", decoder_model_merged: "q4f16" } : { encoder_model: "q4f16", decoder_model_merged: "q4f16" } };
      }
      return { device: "webgpu", dtype: { encoder_model: "q4", decoder_model_merged: "q4" } };
    }
  } catch {}
  return { device: "wasm", dtype: { encoder_model: "q4", decoder_model_merged: "q4" } };
}

async function load(quality, cpu) {
  const progress_callback = (p) => postMessage({ type: "progress", status: p.status, file: p.file, loaded: p.loaded, total: p.total });
  let pick = await pickDevice(quality, cpu);
  try {
    asr = await pipeline("automatic-speech-recognition", MODEL, { ...pick, progress_callback });
  } catch (e) {
    if (pick.device === "wasm") throw e;
    pick = { device: "wasm", dtype: { encoder_model: "q4", decoder_model_merged: "q4" } };
    asr = await pipeline("automatic-speech-recognition", MODEL, { ...pick, progress_callback });
  }
  postMessage({ type: "ready", device: pick.device });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") await load(m.quality, m.cpu);
    if (m.type === "run") {
      const out = await asr(m.audio, { language: "hebrew", task: "transcribe", return_timestamps: true });
      postMessage({ type: "result", id: m.id, text: out.text, chunks: out.chunks || [] });
    }
  } catch (err) {
    postMessage({ type: "error", id: m.id, message: String(err?.message || err) });
  }
};
