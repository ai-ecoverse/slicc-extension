import { EXTENSION_BRIDGE_PORT_NAME } from '@slicc/shared-ts';
import {
  BRIDGE_ALLOWED_ORIGINS,
  BRIDGE_DEV_ORIGINS,
  buildDefaultBridgeSwDeps,
  checkBridgeTabProtection,
  handleBridgePortConnect,
  installBridgeFrontListeners,
  noteBridgeMainFrameResponse,
  noteBridgeTabChanged,
  postOpenSettingsToWelcomedLeaderPorts,
} from './bridge-sw.js';
import { handleCapturePopupMessage } from './capture-popup-sw.js';
import {
  acquireDebuggerAttachment,
  installCdpProxyListeners,
  maybeUnmaskCdpFrame,
  releaseDebuggerAttachment,
} from './cdp-proxy-sw.js';
import { CHERRY_PANEL_PORT_NAME } from './cherry-panel-protocol.js';
import {
  handleCherryPanelConnect,
  setCherryPanelJoinUrl,
  setCherryPanelRecoveryDeps,
} from './cherry-panel-sw.js';
import { installDiscoveryObserver } from './discovery-sw.js';
import { rawSessionStarter } from './fetch-proxy-raw.js';
import { handleFetchProxyConnectionAsync, type PortLike } from './fetch-proxy-shared.js';
import { installHandoffNotifications } from './handoff-notifications-sw.js';
import {
  ensureLeaderTab,
  focusLeaderTab,
  installLeaderTabListeners,
  readStoredLeaderTabId,
  reloadLeaderTabIfExists,
  writeStoredLeaderTabId,
} from './leader-tab-sw.js';
import { handleMountMessage, handleMountSignAndForwardPort } from './mount-backends-sw.js';
import { installProtectedFrameTracker } from './protected-frames-sw.js';
import { createRawFetchCapture, installRawFetchCapture } from './raw-fetch-capture.js';
import { handleRelayMessage } from './relay-sw.js';
import {
  buildReloadedPipelinePromise,
  handleSecretsCrudPort,
  handleSecretsMessage,
} from './secrets-sw.js';
import { routeSwMessage, type SwMessageHandler } from './sw-message-router.js';
import { beginPortPin, type PortPinDeps } from './sw-pinned-port.js';

const BRIDGE_ORIGINS = __SLICC_EXT_DEV__
  ? [...BRIDGE_ALLOWED_ORIGINS, ...BRIDGE_DEV_ORIGINS]
  : BRIDGE_ALLOWED_ORIGINS;

const selfAdoptLeaderTabId = async (tabId: number): Promise<void> => {
  try {
    await writeStoredLeaderTabId(tabId);
  } catch {}
};

const bridgeSwDeps = buildDefaultBridgeSwDeps({
  writeStoredLeaderTabId: selfAdoptLeaderTabId,
  attachDebugger: (tabId) => acquireDebuggerAttachment(tabId, 'bridge'),
  detachDebugger: (tabId) => releaseDebuggerAttachment(tabId, 'bridge'),
  sendDebuggerCommand: async (tabId, method, params) => {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    return result ?? {};
  },
  maybeUnmaskCdpFrame,
  allowedOrigins: BRIDGE_ORIGINS,
  onLeaderJoinUrl: (joinUrl) => {
    setCherryPanelJoinUrl(joinUrl);
  },
});

const portPinDeps: PortPinDeps = {
  readStoredLeaderTabId,
  writeStoredLeaderTabId: selfAdoptLeaderTabId,
  allowedOrigins: BRIDGE_ORIGINS,
};

installLeaderTabListeners();

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[slicc-sw] setPanelBehavior failed', err));

setCherryPanelRecoveryDeps({ reloadLeaderTabIfExists });

installHandoffNotifications();
installDiscoveryObserver();
installProtectedFrameTracker();

installCdpProxyListeners();

installBridgeFrontListeners(bridgeSwDeps);

for (const event of [chrome.webRequest.onHeadersReceived, chrome.webRequest.onResponseStarted]) {
  event.addListener(noteBridgeMainFrameResponse, { urls: ['<all_urls>'], types: ['main_frame'] });
}

chrome.tabs.onUpdated.addListener(
  (tabId: number, changeInfo: ChromeTabChangeInfo, tab: ChromeTab) => {
    noteBridgeTabChanged(tabId);
    const url = changeInfo.url ?? tab.pendingUrl;
    if (!url) return;
    const bridgeDetached = checkBridgeTabProtection(tabId, url);
    for (const detachedTabId of bridgeDetached) {
      releaseDebuggerAttachment(detachedTabId, 'bridge').catch(() => {});
    }
  }
);

const rawFetchDeps = { capture: createRawFetchCapture() };
installRawFetchCapture(rawFetchDeps.capture);

const SW_MESSAGE_HANDLERS: readonly SwMessageHandler[] = [
  handleCapturePopupMessage,
  handleRelayMessage,
  handleMountMessage,
  handleSecretsMessage,
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
  routeSwMessage(SW_MESSAGE_HANDLERS, message, sender, sendResponse)
);

const EXTERNAL_PINNED_PORTS: Readonly<Record<string, (port: ChromeRuntimePort) => void>> = {
  'fetch-proxy.fetch': (port) => connectExternalFetchProxy(port),
  'secrets.crud': (port) => handleSecretsCrudPort(port, portPinDeps),
  'mount.sign-and-forward': (port) => handleMountSignAndForwardPort(port, portPinDeps),
};

chrome.runtime.onConnectExternal.addListener((port: ChromeRuntimePort) => {
  if (port.name === EXTENSION_BRIDGE_PORT_NAME) {
    handleBridgePortConnect(port, bridgeSwDeps).catch((err) => {
      console.error('[slicc-sw] CDP bridge connect failed', err);
    });
    return;
  }
  const connect = Object.hasOwn(EXTERNAL_PINNED_PORTS, port.name)
    ? EXTERNAL_PINNED_PORTS[port.name]
    : undefined;
  if (!connect || !BRIDGE_ORIGINS.includes(port.sender?.origin ?? '')) {
    port.disconnect();
    return;
  }
  connect(port);
});

function connectExternalFetchProxy(port: ChromeRuntimePort): void {
  const pipelinePromise = beginPortPin(port, portPinDeps, 'fetch-proxy').then((pin) => {
    if (!pin.ok) throw new Error(pin.error);
    return buildReloadedPipelinePromise();
  });
  pipelinePromise.catch((err) => {
    console.error('[sw] external fetch-proxy init failed', err);
  });
  handleFetchProxyConnectionAsync(
    port as PortLike,
    pipelinePromise,
    rawSessionStarter(port as PortLike, pipelinePromise, rawFetchDeps)
  );
}

chrome.runtime.onConnect.addListener((port) => {
  const extOrigin = `chrome-extension://${chrome.runtime.id}`;
  const portOrigin =
    port.sender?.origin ?? (port.sender?.url ? new URL(port.sender.url).origin : undefined);
  if (port.sender?.id !== chrome.runtime.id || portOrigin !== extOrigin) return;
  if (port.name === CHERRY_PANEL_PORT_NAME) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    handleCherryPanelConnect(port, {
      ensureLeaderTab,
      reloadLeaderTabIfExists,
      focusLeaderTab,
      openSettingsOnLeader: () => {
        postOpenSettingsToWelcomedLeaderPorts();
      },
    }).catch((err) => console.error('[slicc-sw] handleCherryPanelConnect failed', err));
    return;
  }
  if (port.name !== 'fetch-proxy.fetch') return;
  const pipelinePromise = buildReloadedPipelinePromise();
  pipelinePromise.catch((err) => {
    console.error('[sw] fetch-proxy init failed', err);
  });
  handleFetchProxyConnectionAsync(
    port as PortLike,
    pipelinePromise,
    rawSessionStarter(port as PortLike, pipelinePromise, rawFetchDeps)
  );
});
