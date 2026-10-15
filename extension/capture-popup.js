var __defProp2 = Object.defineProperty;
var __name2 = (target, value) => __defProp2(target, "name", { value, configurable: true });
var __defProp = Object.defineProperty;
var __name = /* @__PURE__ */ __name2((target, value) => __defProp(target, "name", { value, configurable: true }), "__name");
const dot = document.getElementById("dot");
const label = document.getElementById("label");
const hint = document.getElementById("hint");
const action = document.getElementById("action");
const request = parseRequest();
let settled = false;
function parseRequest() {
  try {
    const raw = new URLSearchParams(location.search).get("req");
    if (!raw) return null;
    let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
__name2(parseRequest, "parseRequest");
__name(parseRequest, "parseRequest");
function send(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
    });
  } catch {
  }
}
__name2(send, "send");
__name(send, "send");
function setStatus(text, isError) {
  label.textContent = text;
  if (isError) dot.className = "dot dot--error";
}
__name2(setStatus, "setStatus");
__name(setStatus, "setStatus");
function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
__name2(bytesToBase64, "bytesToBase64");
__name(bytesToBase64, "bytesToBase64");
function describeMediaError(err) {
  if (err?.name) return `${err.name}: ${err.message || ""}`.trim();
  return err?.message ? err.message : String(err);
}
__name2(describeMediaError, "describeMediaError");
__name(describeMediaError, "describeMediaError");
function fail(error) {
  settled = true;
  setStatus(error, true);
  hint.textContent = "";
  send({ source: "capture-popup", requestId: request?.requestId, ok: false, error });
  setTimeout(() => window.close(), 1200);
}
__name2(fail, "fail");
__name(fail, "fail");
function succeed(bytes, mimeType, width, height, durationMs) {
  settled = true;
  const msg = {
    source: "capture-popup",
    requestId: request.requestId,
    ok: true,
    bytesBase64: bytesToBase64(bytes),
    mimeType,
    width,
    height
  };
  if (typeof durationMs === "number") msg.durationMs = durationMs;
  send(msg);
  setTimeout(() => window.close(), 200);
}
__name2(succeed, "succeed");
__name(succeed, "succeed");
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!sender.url || !sender.url.startsWith("chrome-extension://" + chrome.runtime.id)) return false;
  if (msg && msg.target === "capture-popup" && msg.type === "capture-abort" && (!request || msg.requestId === request.requestId)) {
    window.close();
  }
  return false;
});
window.addEventListener("pagehide", () => {
  if (settled) return;
  settled = true;
  send({
    source: "capture-popup",
    requestId: request?.requestId,
    ok: false,
    error: "capture cancelled"
  });
});
if (!request) {
  fail("invalid capture request");
} else if (request.kind === "screen") {
  setupScreenButton();
} else {
  runCameraCapture();
}
function setupScreenButton() {
  setStatus("Screen capture ready");
  hint.textContent = "Click below, then choose a screen, window, or tab to capture.";
  action.style.display = "inline-block";
  action.textContent = "Capture screen";
  action.addEventListener("click", () => {
    action.disabled = true;
    runScreenCapture();
  });
}
__name2(setupScreenButton, "setupScreenButton");
__name(setupScreenButton, "setupScreenButton");
async function runScreenCapture() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    fail(describeMediaError(err));
    return;
  }
  try {
    setStatus("Capturing\u2026");
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await new Promise((res, rej) => {
      video.onloadedmetadata = () => video.play().then(res).catch(rej);
      video.onerror = () => rej(new Error("Failed to load screen stream"));
    });
    await new Promise((r) => setTimeout(r, 100));
    const width = video.videoWidth;
    const height = video.videoHeight;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get canvas context");
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise(
      (res, rej) => canvas.toBlob(
        (b) => b ? res(b) : rej(new Error("Failed to create image blob")),
        request.mimeType,
        request.quality
      )
    );
    succeed(new Uint8Array(await blob.arrayBuffer()), request.mimeType, width, height);
  } catch (err) {
    fail(describeMediaError(err));
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}
__name2(runScreenCapture, "runScreenCapture");
__name(runScreenCapture, "runScreenCapture");
async function runCameraCapture() {
  const req = request;
  const wantVideo = req.mode === "photo" || req.captureVideo !== false;
  const wantAudio = !!req.captureAudio && req.mode === "video";
  if (!wantVideo && !wantAudio) {
    fail("camera capture: at least one of video or audio must be requested");
    return;
  }
  setStatus("Requesting permission\u2026");
  hint.textContent = "Allow camera/microphone access when prompted.";
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: wantVideo, audio: wantAudio });
    for (const t of probe.getTracks()) t.stop();
  } catch (err) {
    fail(describeMediaError(err));
    return;
  }
  const videoId = wantVideo ? await resolveDeviceId(req.deviceId, "videoinput") : void 0;
  const audioId = wantAudio ? await resolveDeviceId(req.audioDeviceId, "audioinput") : void 0;
  let stream;
  try {
    stream = await getStreamWithFallback({
      wantVideo,
      wantAudio,
      videoId,
      audioId,
      width: req.width,
      height: req.height,
      frameRate: req.frameRate,
      exact: !!req.exactSize
    });
  } catch (err) {
    fail(describeMediaError(err));
    return;
  }
  try {
    setStatus(req.mode === "photo" ? "Capturing photo\u2026" : "Recording\u2026");
    hint.textContent = "";
    if (req.mode === "photo") {
      const r = await capturePhoto(stream, req);
      succeed(r.bytes, r.mimeType, r.width, r.height);
    } else {
      const r = await captureClip(stream, req, wantVideo);
      succeed(r.bytes, r.mimeType, r.width, r.height, r.durationMs);
    }
  } catch (err) {
    fail(describeMediaError(err));
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}
__name2(runCameraCapture, "runCameraCapture");
__name(runCameraCapture, "runCameraCapture");
async function resolveDeviceId(idOrIndex, kind) {
  if (!idOrIndex) return void 0;
  if (!/^\d+$/.test(idOrIndex)) return idOrIndex;
  if (!navigator.mediaDevices.enumerateDevices) return void 0;
  const all = await navigator.mediaDevices.enumerateDevices();
  const dev = all.filter((d) => d.kind === kind)[parseInt(idOrIndex, 10)];
  return dev ? dev.deviceId : void 0;
}
__name2(resolveDeviceId, "resolveDeviceId");
__name(resolveDeviceId, "resolveDeviceId");
async function getStreamWithFallback(spec) {
  const buildVideo = /* @__PURE__ */ __name((mode) => {
    if (!spec.wantVideo) return false;
    const c = {};
    if (spec.videoId) c.deviceId = { exact: spec.videoId };
    if (spec.width) c.width = mode === "exact" ? { exact: spec.width } : { ideal: spec.width };
    if (spec.height) c.height = mode === "exact" ? { exact: spec.height } : { ideal: spec.height };
    if (spec.frameRate)
      c.frameRate = mode === "exact" ? { exact: spec.frameRate } : { ideal: spec.frameRate };
    return Object.keys(c).length > 0 ? c : true;
  }, "buildVideo");
  const audio = /* @__PURE__ */ __name(() => {
    if (!spec.wantAudio) return false;
    if (spec.audioId) return { deviceId: { exact: spec.audioId } };
    return true;
  }, "audio");
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: buildVideo(spec.exact ? "exact" : "ideal"),
      audio: audio()
    });
  } catch (err) {
    if (!spec.exact || err.name !== "OverconstrainedError" && err.name !== "NotReadableError") {
      throw err;
    }
    return await navigator.mediaDevices.getUserMedia({
      video: buildVideo("ideal"),
      audio: audio()
    });
  }
}
__name2(getStreamWithFallback, "getStreamWithFallback");
__name(getStreamWithFallback, "getStreamWithFallback");
async function capturePhoto(stream, req) {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await new Promise((res, rej) => {
    video.onloadedmetadata = () => video.play().then(res).catch(rej);
    video.onerror = () => rej(new Error("Failed to load camera stream"));
  });
  await new Promise((r) => requestAnimationFrame(() => r()));
  await new Promise((r) => requestAnimationFrame(() => r()));
  const warmupMs = req.warmupMs != null ? req.warmupMs : 1500;
  if (warmupMs > 0) await new Promise((r) => setTimeout(r, warmupMs));
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas context");
  ctx.drawImage(video, 0, 0, width, height);
  const blob = await new Promise(
    (res, rej) => canvas.toBlob(
      (b) => b ? res(b) : rej(new Error("Failed to encode photo")),
      req.mimeType,
      req.quality
    )
  );
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width,
    height,
    mimeType: blob.type || req.mimeType
  };
}
__name2(capturePhoto, "capturePhoto");
__name(capturePhoto, "capturePhoto");
async function captureClip(stream, req, wantVideo) {
  let width = 0;
  let height = 0;
  if (wantVideo) {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await new Promise((res, rej) => {
      video.onloadedmetadata = () => video.play().then(res).catch(rej);
      video.onerror = () => rej(new Error("Failed to load camera stream"));
    });
    await new Promise((r) => requestAnimationFrame(() => r()));
    width = video.videoWidth;
    height = video.videoHeight;
  }
  const durationMs = Math.max(100, Math.min(req.durationMs || 5e3, 6e4));
  const supported = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(req.mimeType) ? req.mimeType : "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType: supported });
  const chunks = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  const stopped = new Promise((res) => {
    recorder.onstop = () => res();
  });
  recorder.start();
  await new Promise((r) => setTimeout(r, durationMs));
  recorder.stop();
  await stopped;
  const blob = new Blob(chunks, { type: supported });
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width,
    height,
    mimeType: blob.type || supported,
    durationMs
  };
}
__name2(captureClip, "captureClip");
__name(captureClip, "captureClip");
