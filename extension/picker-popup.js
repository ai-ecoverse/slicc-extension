var __defProp2 = Object.defineProperty;
var __name2 = (target, value) => __defProp2(target, "name", { value, configurable: true });
var __defProp = Object.defineProperty;
var __name = /* @__PURE__ */ __name2((target, value) => __defProp(target, "name", { value, configurable: true }), "__name");
const PENDING_MOUNT_DB = "slicc-pending-mount";
const params = new URLSearchParams(location.search);
const kind = params.get("kind") || "directory";
const requestId = params.get("requestId") || "";
let filters = [];
try {
  filters = JSON.parse(params.get("filters") || "[]");
  if (!Array.isArray(filters)) filters = [];
} catch (_e) {
  filters = [];
}
const KIND_TITLES = {
  directory: { title: "slicc mount", label: "Select directory", working: "Storing..." },
  "usb-device": { title: "slicc usb", label: "Select USB device", working: "Connecting..." },
  "serial-port": { title: "slicc serial", label: "Select serial port", working: "Connecting..." },
  "hid-device": { title: "slicc hid", label: "Select HID device", working: "Connecting..." }
};
function applyKindLabels() {
  const t = KIND_TITLES[kind] || KIND_TITLES.directory;
  try {
    document.title = t.title;
  } catch (_e) {
  }
  document.getElementById("pickBtn").textContent = t.label;
  document.getElementById("label").textContent = t.working;
}
__name2(applyKindLabels, "applyKindLabels");
__name(applyKindLabels, "applyKindLabels");
function send(extra) {
  try {
    chrome.runtime.sendMessage(
      Object.assign({ source: "picker-popup", kind, requestId }, extra),
      function() {
        if (chrome.runtime.lastError) {
        }
      }
    );
  } catch (_e) {
  }
}
__name2(send, "send");
__name(send, "send");
function openDb() {
  return new Promise(function(resolve, reject) {
    const req = indexedDB.open(PENDING_MOUNT_DB, 1);
    req.onupgradeneeded = function() {
      if (!req.result.objectStoreNames.contains("handles")) {
        req.result.createObjectStore("handles");
      }
    };
    req.onsuccess = function() {
      resolve(req.result);
    };
    req.onerror = function() {
      reject(req.error);
    };
  });
}
__name2(openDb, "openDb");
__name(openDb, "openDb");
async function pickDirectory() {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const idbKey = "pendingMount:" + requestId;
    const db = await openDb();
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, idbKey);
    await new Promise(function(resolve, reject) {
      tx.oncomplete = resolve;
      tx.onerror = function() {
        reject(tx.error);
      };
      tx.onabort = function() {
        reject(tx.error || new Error("Transaction aborted"));
      };
    });
    db.close();
    send({ handleInIdb: true, idbKey, dirName: handle.name });
  } catch (err) {
    if (err && err.name === "AbortError") send({ cancelled: true });
    else send({ error: err ? err.message || String(err) : "Unknown error" });
  }
}
__name2(pickDirectory, "pickDirectory");
__name(pickDirectory, "pickDirectory");
async function pickUsb() {
  if (!navigator.usb || typeof navigator.usb.requestDevice !== "function") {
    throw new Error("WebUSB is not available");
  }
  const device = await navigator.usb.requestDevice({ filters });
  send({
    granted: true,
    info: {
      vendorId: device.vendorId,
      productId: device.productId,
      serialNumber: device.serialNumber || void 0
    }
  });
}
__name2(pickUsb, "pickUsb");
__name(pickUsb, "pickUsb");
async function pickSerial() {
  if (!navigator.serial || typeof navigator.serial.requestPort !== "function") {
    throw new Error("Web Serial is not available");
  }
  const port = await navigator.serial.requestPort(filters.length ? { filters } : {});
  if (!port) {
    send({ cancelled: true });
    return;
  }
  const info = typeof port.getInfo === "function" ? port.getInfo() : {};
  send({
    granted: true,
    info: { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId }
  });
}
__name2(pickSerial, "pickSerial");
__name(pickSerial, "pickSerial");
async function pickHid() {
  if (!navigator.hid || typeof navigator.hid.requestDevice !== "function") {
    throw new Error("WebHID is not available");
  }
  const devices = await navigator.hid.requestDevice({ filters });
  const device = Array.isArray(devices) ? devices[0] : devices;
  if (!device) {
    send({ cancelled: true });
    return;
  }
  send({ granted: true, info: { vendorId: device.vendorId, productId: device.productId } });
}
__name2(pickHid, "pickHid");
__name(pickHid, "pickHid");
async function onClick() {
  document.getElementById("pickBtn").style.display = "none";
  document.getElementById("label").style.display = "";
  try {
    if (kind === "directory") await pickDirectory();
    else if (kind === "usb-device") await pickUsb();
    else if (kind === "serial-port") await pickSerial();
    else if (kind === "hid-device") await pickHid();
    else send({ error: "unknown picker kind: " + kind });
  } catch (err) {
    if (err && (err.name === "AbortError" || err.name === "NotFoundError"))
      send({ cancelled: true });
    else send({ error: err ? err.message || String(err) : "Unknown error" });
  }
  window.close();
}
__name2(onClick, "onClick");
__name(onClick, "onClick");
applyKindLabels();
document.getElementById("pickBtn").addEventListener("click", onClick);
