
function mountSlicc(options) {
  if (!options?.container && !options?.iframe)
    throw new Error("mountSlicc: either options.container or options.iframe is required");
  return mountSliccImpl(options);
}
function mountSliccImpl(options) {
  const sdkCreatedIframe = !options.iframe;
  const iframe = options.iframe ?? document.createElement("iframe");
  const src = new URL(options.sliccOrigin);
  const sliccOrigin = src.origin;
  src.searchParams.set("cherry", "1");
  if (options.uiOnly) src.searchParams.set("ui-only", "1");
  iframe.src = src.toString();
  if (sdkCreatedIframe) {
    iframe.style.border = "0";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    options.container?.appendChild(iframe);
  }
  let channelId = null;
  const pendingExports = new Map();
  const cdpHandler = createCdpHandler(options);
  const post = (env) => {
    if (options.__test_post) {
      options.__test_post(env);
      return;
    }
    iframe.contentWindow?.postMessage(env, sliccOrigin);
  };
  const mismatchTimers = new Map();
  const handleMismatch = (env) => {
    if (mismatchTimers.has(env.channelId)) return;
    post({ cherry: 2, channelId: env.channelId, kind: "handshake.version-mismatch", peerVersion: env.cherry });
    mismatchTimers.set(env.channelId, setTimeout(() => {
      mismatchTimers.delete(env.channelId);
      options.hooks?.onProtocolMismatch?.(env.cherry, 2);
    }, 250));
  };
  const VALID_KINDS = new Set([
    "handshake.hello",
    "handshake.welcome",
    "handshake.version-mismatch",
    "cdp.request",
    "cdp.response",
    "cdp.event",
    "permission.request",
    "permission.response",
    "host.event",
    "slicc.event",
    "session.export.request",
    "session.export.cancel",
    "session.export.progress",
    "session.export.response",
    "session.export.error"
  ]);
  function isEnvelope(data) {
    if (typeof data !== "object" || data === null) return false;
    return typeof data.cherry === "number" && [2].includes(data.cherry) && typeof data.channelId === "string" && typeof data.kind === "string" && VALID_KINDS.has(data.kind);
  }
  function isMismatch(data) {
    return typeof data === "object" && data !== null && typeof data.cherry === "number" && ![2].includes(data.cherry) && typeof data.channelId === "string" && typeof data.kind === "string";
  }
  function buildWelcome(newChannelId) {
    const features = {
      terminal: true,
      files: true,
      memory: true,
      browser: true,
      modelPicker: true,
      history: true,
      nav: true,
      newSprinkle: true,
      monitor: true,
      showTimestamps: true,
      ...options.features
    };
    const env = { cherry: 2, channelId: newChannelId, kind: "handshake.welcome", joinUrl: options.joinToken, features };
    if (options.theme) try {
      env.theme = JSON.stringify(options.theme);
    } catch {
    }
    if (options.layout) try {
      env.layout = JSON.stringify(options.layout);
    } catch {
    }
    if (options.effortLevel) env.effortLevel = options.effortLevel;
    if (options.flags) try {
      env.flags = JSON.stringify(options.flags);
    } catch {
    }
    return env;
  }
  async function handleEnvelope(env) {
    switch (env.kind) {
      case "handshake.hello": {
        const timer = mismatchTimers.get(env.channelId);
        if (timer !== void 0) {
          clearTimeout(timer);
          mismatchTimers.delete(env.channelId);
        }
        channelId = env.channelId;
        post(buildWelcome(channelId));
        options.hooks?.onHandshakeComplete?.();
        return;
      }
      case "cdp.request": {
        const result = await dispatchCdp(env, cdpHandler, options.hooks?.onPermissionRequest);
        post({ cherry: 2, channelId, kind: "cdp.response", id: env.id, ...result });
        return result;
      }
      case "slicc.event": {
        options.hooks?.onSliccEvent?.(env.name, env.detail);
        if (env.name === "open-url" && options.capabilities.openUrl) {
          const url = env.detail?.url;
          if (url) options.hooks?.onOpenUrl?.(url);
        }
        return;
      }
      case "session.export.progress":
        pendingExports.get(env.requestId)?.onProgress?.({
          phase: env.phase,
          processedBytes: env.processedBytes,
          estimatedBytes: env.estimatedBytes
        });
        return;
      case "session.export.response":
        resolveExport(pendingExports, env);
        return;
      case "session.export.error":
        rejectExport(pendingExports, env);
        return;
    }
  }
  function isFromIframe(event) {
    return event.origin === sliccOrigin && event.source === iframe.contentWindow;
  }
  const onMessage = (event) => {
    if (channelId !== null && isFromIframe(event) && isEnvelope(event.data) && event.data.kind === "handshake.hello" && event.data.channelId !== channelId) {
      handleEnvelope(event.data).catch((e) => console.error("[cherry] envelope handling failed", e));
      return;
    }
    if (event.origin !== sliccOrigin || event.source !== iframe.contentWindow) {
      if (isMismatch(event.data) && isFromIframe(event) && event.data.kind === "handshake.hello" && event.data.channelId !== channelId)
        handleMismatch(event.data);
      return;
    }
    if (!isEnvelope(event.data) || channelId !== null && event.data.channelId !== channelId) return;
    handleEnvelope(event.data).catch((e) => console.error("[cherry] envelope handling failed", e));
  };
  window.addEventListener("message", onMessage);
  return {
    iframe,
    emitHostEvent(name, detail) {
      if (channelId === null) return;
      post({ cherry: 2, channelId, kind: "host.event", name, detail });
    },
    exportSession(opts) {
      if (channelId === null) return Promise.reject(new Error("transfer-aborted"));
      const signal = opts?.signal;
      if (signal?.aborted) return Promise.reject(new Error("transfer-aborted"));
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (pendingExports.has(requestId)) {
            pendingExports.delete(requestId);
            post({ cherry: 2, channelId, kind: "session.export.cancel", requestId });
            reject(new Error("transfer-aborted"));
          }
        };
        pendingExports.set(requestId, { resolve, reject, onProgress: opts?.onProgress, onAbort, signal });
        signal?.addEventListener("abort", onAbort, { once: true });
        const env = { cherry: 2, channelId, kind: "session.export.request", requestId };
        if (opts?.sessionId !== void 0) env.sessionId = opts.sessionId;
        post(env);
      });
    },
    destroy() {
      window.removeEventListener("message", onMessage);
      for (const [, entry] of pendingExports) {
        entry.signal?.removeEventListener("abort", entry.onAbort);
        entry.reject(new Error("transfer-aborted"));
      }
      pendingExports.clear();
      for (const [, timer] of mismatchTimers) clearTimeout(timer);
      mismatchTimers.clear();
      if (sdkCreatedIframe) iframe.remove();
    }
  };
}
function createCdpHandler(options) {
  const objectIds = new WeakMap();
  const idToObj = new Map();
  let nextId = 1;
  const getObjectId = (obj) => {
    let id = objectIds.get(obj);
    if (id === void 0) {
      id = nextId++;
      objectIds.set(obj, id);
      idToObj.set(id, obj);
    }
    return id;
  };
  const describe = (value) => {
    const type = typeof value;
    if (value === null) return { type: "object", subtype: "null", value: null };
    if (type === "undefined") return { type: "undefined" };
    if (type === "number" || type === "boolean" || type === "string") return { type, value };
    return { type: "object", description: String(value) };
  };
  const evalFn = eval;
  return async function(method, params) {
    switch (method) {
      case "Runtime.evaluate": {
        try {
          let result = evalFn(String(params.expression ?? ""));
          if (result instanceof Promise) result = await result;
          return { result: describe(result) };
        } catch (e) {
          return { result: { type: "object", subtype: "error" }, exceptionDetails: { text: e instanceof Error ? e.message : String(e), exception: { type: "object", description: String(e) } } };
        }
      }
      case "DOM.getDocument":
        return { root: { nodeId: getObjectId(document), nodeName: "#document", childNodeCount: 1 } };
      case "DOM.querySelector": {
        const node = idToObj.get(Number(params.nodeId)) ?? document;
        const el = node.querySelector?.(String(params.selector ?? "")) ?? null;
        return { nodeId: el ? getObjectId(el) : 0 };
      }
      case "DOM.getBoxModel": {
        const rect = idToObj.get(Number(params.nodeId))?.getBoundingClientRect?.();
        if (!rect) throw new Error("DOM.getBoxModel(no-rect)");
        return { model: { content: [rect.left, rect.top, rect.right, rect.top, rect.right, rect.bottom, rect.left, rect.bottom], width: rect.width, height: rect.height } };
      }
      case "Input.dispatchMouseEvent": {
        const x = Number(params.x ?? 0), y = Number(params.y ?? 0);
        const el = document.elementFromPoint(x, y);
        if (el && params.type === "mousePressed")
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        return {};
      }
      case "Input.dispatchKeyEvent": {
        const el = document.activeElement;
        if (el && params.type === "keyDown" && typeof params.key === "string")
          el.dispatchEvent(new KeyboardEvent("keydown", { key: params.key, bubbles: true }));
        return {};
      }
      case "Page.captureScreenshot":
        if (options.capabilities.screenshot !== "html2canvas") throw new Error("Page.captureScreenshot not supported");
        throw new Error("html2canvas not available in merged extension");
      case "Page.navigate":
        if (!options.capabilities.navigate) throw new Error("Page.navigate not supported");
        location.assign(String(params.url ?? ""));
        return { frameId: "cherry-frame", loaderId: "cherry-loader" };
      case "Target.createTarget":
        if (!options.capabilities.openUrl) throw new Error("Target.createTarget not supported");
        options.hooks?.onOpenUrl?.(String(params.url ?? ""));
        return { targetId: "cherry-opened" };
      default:
        throw new Error(`Cherry: unsupported CDP method '${method}'`);
    }
  };
}
async function dispatchCdp(env, handler, onPermissionRequest) {
  const domain = env.method.split(".")[0] ?? env.method;
  try {
    const allowed = onPermissionRequest ? await onPermissionRequest(domain) : true;
    if (!allowed) return { error: { code: -32601, message: `Cherry: permission denied for ${domain}` } };
    return { result: await handler(env.method, env.params ?? {}) };
  } catch (e) {
    return { error: { code: -32e3, message: e instanceof Error ? e.message : String(e) } };
  }
}
function resolveExport(map, env) {
  const entry = map.get(env.requestId);
  if (!entry) return;
  entry.signal?.removeEventListener("abort", entry.onAbort);
  map.delete(env.requestId);
  if (!(env.blob instanceof Blob) || env.blob.type !== "application/zip") {
    entry.reject(new Error("transfer-corrupt"));
    return;
  }
  entry.resolve(env.blob);
}
function rejectExport(map, env) {
  const entry = map.get(env.requestId);
  if (!entry) return;
  entry.signal?.removeEventListener("abort", entry.onAbort);
  map.delete(env.requestId);
  const CODES = new Set(["permission-denied", "redaction-unavailable", "session-not-found", "transfer-aborted", "transfer-corrupt", "schema-invalid", "attachment-unreadable"]);
  entry.reject(new Error(CODES.has(env.code) ? env.code : "transfer-corrupt"));
}

var SLICC_HOSTED_ORIGIN = "https://www.sliccy.ai";

var KNOWN_PREFIXES = [
  "ghp_",
 
  "gho_",
 
  "ghu_",
 
  "ghs_",
 
  "ghr_",
 
  "github_pat_",
 
  "sk-",
 
  "pk-",
 
  "xoxb-",
 
  "xoxp-",
 
  "xoxa-",
 
  "xoxs-",
 
  "AKIA",
 
  "ABIA",
 
  "ACCA",
 
  "ASIA",
 
  "sk-ant-",
 
  "Bearer "
 
  iframe.style.display = "none";
  let restored = false;
  const restore = (viaRaf) => {
    if (restored) return;
    restored = true;
    iframe.style.display = previousDisplay;
    nudgeInFlight.delete(iframe);
    if (viaRaf) onRafRestore?.();
    onDone?.();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => restore(true));
    });
  }
  setTimeout(() => restore(false), 100);
}

var CHERRY_PANEL_PORT_NAME = "cherry-panel";
var SIDE_PANEL_FEATURES = {
  terminal: false,
  files: false,
  memory: false,
  browser: false,
  newSprinkle: false,
  monitor: false,
  modelPicker: false,
  history: true,
  nav: true
};

var sliccOriginDefault = false ? "http://localhost:8787" : SLICC_HOSTED_ORIGIN;
var BOOT_TIMEOUT_MS = 2e4;
var IFRAME_LOAD_TIMEOUT_MS = 15e3;
function createSidePanelController(deps) {
  let handle = null;
  let currentJoinUrl = null;
  let disposed = false;
  let port = null;
  let reconnectDelay = 250;
  let bootTimer = null;
  let iframeLoadTimer = null;
  const clearBootTimer = () => {
    if (bootTimer) {
      clearTimeout(bootTimer);
      bootTimer = null;
    }
  };
  const clearIframeLoadTimer = () => {
    if (iframeLoadTimer) {
      clearTimeout(iframeLoadTimer);
      iframeLoadTimer = null;
    }
  };
  const blankIframe = () => {
    deps.iframe.setAttribute("src", "about:blank");
  };
  const teardown = () => {
    clearBootTimer();
    clearIframeLoadTimer();
    handle?.destroy();
    handle = null;
    currentJoinUrl = null;
    blankIframe();
  };
  const goDisconnected = () => {
    teardown();
    deps.setStatus("disconnected");
  };
  const onIframeLoad = () => {
    if (deps.iframe.getAttribute("src") === "about:blank") return;
    clearIframeLoadTimer();
    nudgeIframeRepaint(deps.iframe);
  };
  deps.iframe.addEventListener("load", onIframeLoad);
  deps.iframe.addEventListener("error", () => {
    if (!disposed && handle) goDisconnected();
  });
  const requestLeaderFocus = (openSettings) => {
    try {
      port?.postMessage({ kind: "focus-leader", openSettings });
    } catch {
    }
  };
  const onMessage = (raw) => {
    const msg = raw;
    if (msg?.kind !== "join-url") return;
    if (msg.state === "booting") {
      if (handle) {
        deps.setStatus("live");
        return;
      }
      deps.setStatus("starting");
      clearBootTimer();
      bootTimer = setTimeout(() => {
        bootTimer = null;
        if (!disposed) goDisconnected();
      }, BOOT_TIMEOUT_MS);
      return;
    }
    if (msg.state === "disconnected") {
      goDisconnected();
      return;
    }
    reconnectDelay = 250;
    clearBootTimer();
    if (msg.joinUrl === currentJoinUrl && handle) {
      deps.setStatus("live");
      return;
    }
    handle?.destroy();
    handle = null;
    blankIframe();
    currentJoinUrl = msg.joinUrl;
    clearIframeLoadTimer();
    iframeLoadTimer = setTimeout(() => {
      iframeLoadTimer = null;
      if (!disposed && handle) goDisconnected();
    }, IFRAME_LOAD_TIMEOUT_MS);
    handle = deps.mountSlicc({
      iframe: deps.iframe,
      joinToken: msg.joinUrl,
      uiOnly: true,
      sliccOrigin: deps.sliccOrigin,
      capabilities: { navigate: false, screenshot: "none", openUrl: false },
      features: SIDE_PANEL_FEATURES,
      hooks: {
        // The follower asks to sign in — provider login can't complete in the
       
        // `slicc.focus-leader-tab` is the follower avatar menu's "Bring leader
        // to front" — a plain focus, with nothing to sign in to.
        onSliccEvent: (name) => {
          if (name === "slicc.open-leader-tab") requestLeaderFocus(true);
          if (name === "slicc.focus-leader-tab") requestLeaderFocus(false);
        }
      }
    });
    deps.setStatus("live");
  };
  const wire = () => {
    try {
      port = deps.connect();
    } catch {
      port = null;
      return;
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (disposed) return;
      setTimeout(() => {
        if (!disposed) wire();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5e3);
    });
    try {
      port.postMessage({ kind: "hello" });
    } catch {
    }
  };
  wire();
  return {
    dispose() {
      disposed = true;
      teardown();
      deps.iframe.removeEventListener("load", onIframeLoad);
      try {
        port?.disconnect();
      } catch {
      }
    }
  };
}
if (typeof chrome !== "undefined" && chrome?.runtime?.id) {
  const iframe = document.getElementById("cherry-follower");
  const statusEl = document.getElementById("cherry-status");
  const setStatus = (s) => {
    if (!statusEl) return;
    statusEl.textContent = s === "live" ? "" : s === "starting" ? "Starting SLICC\u2026" : "Disconnected \u2014 reopen to retry";
    statusEl.dataset.state = s;
  };
  createSidePanelController({
    connect: () => chrome.runtime.connect({ name: CHERRY_PANEL_PORT_NAME }),
    mountSlicc,
    iframe,
    setStatus,
    sliccOrigin: sliccOriginDefault
  });
}

export {
  createSidePanelController
};
