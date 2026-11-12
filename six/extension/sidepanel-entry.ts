import { type CherryFeatures, mountSlicc, type SliccHandle } from '@ai-ecoverse/cherry/embed-ui';
import { nextBackoffDelayMs, nudgeIframeRepaint, SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import {
  CHERRY_PANEL_PORT_NAME,
  SEVEN_PANEL_MESSAGE,
  type SevenPanelMessage,
  SIDE_PANEL_FEATURES,
  type SwToPanelMessage,
} from './cherry-panel-protocol.js';

declare const __SLICC_EXT_DEV__: boolean;
const sliccOriginDefault = __SLICC_EXT_DEV__ ? 'http://localhost:8787' : SLICC_HOSTED_ORIGIN;

export type PanelStatus = 'starting' | 'slow' | 'tab' | 'live' | 'disconnected';

const BOOT_TIMEOUT_MS = 20_000;
const SEVEN_HELLO_TIMEOUT_MS = 20_000;
const IFRAME_LOAD_TIMEOUT_MS = 15_000;

const PANEL_STATUS_TEXT: Record<PanelStatus, string> = {
  starting: 'Starting SLICC…',
  slow: 'SLICC is still starting in its tab. Chrome slows down background tabs, so bringing it to the front usually lets it finish.',
  tab: 'SLICC runs in its tab. Reload that tab to use SLICC here, or open it.',
  live: '',
  disconnected: 'Disconnected from SLICC.',
};

const PANEL_ACTION_LABEL: Partial<Record<PanelStatus, string>> = {
  slow: 'Show SLICC tab',
  tab: 'Show SLICC tab',
  disconnected: 'Retry',
};

export interface SidePanelDeps {
  connect: () => ChromeRuntimePort;
  mountSlicc: typeof mountSlicc;
  iframe: HTMLIFrameElement;
  setStatus: (s: PanelStatus) => void;
  sliccOrigin: string;
}

export interface PanelFrameMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

export interface SidePanelController {
  dispose(): void;
  focusLeader(): void;
  frameMessage(event: PanelFrameMessage): void;
  retry(): void;
}

function oneShotTimer() {
  let id: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (id) clearTimeout(id);
    id = null;
  };
  return {
    clear,
    start(ms: number, fn: () => void) {
      clear();
      id = setTimeout(() => {
        id = null;
        fn();
      }, ms);
    },
  };
}

export function sevenSaid(
  { origin, source, data }: PanelFrameMessage,
  url: string | null,
  iframe: HTMLIFrameElement
): SevenPanelMessage | null {
  if (!url || source !== iframe.contentWindow || origin !== new URL(url).origin) return null;
  const said = data as SevenPanelMessage | null;
  return said?.type === SEVEN_PANEL_MESSAGE ? said : null;
}

export function sevenFrame(deps: SidePanelDeps, live: () => boolean) {
  const timer = oneShotTimer();
  let url: string | null = null;
  const wait = (at: string) =>
    timer.start(SEVEN_HELLO_TIMEOUT_MS, () => {
      if (live() && url === at) deps.setStatus('tab');
    });
  return {
    url: () => url,
    leave() {
      timer.clear();
      url = null;
    },
    show(at: string) {
      url = at;
      deps.iframe.setAttribute('src', at);
      deps.setStatus('starting');
      wait(at);
    },
    said(event: PanelFrameMessage) {
      const message = live() ? sevenSaid(event, url, deps.iframe) : null;
      if (!message || !url) return;
      if (message.role === 'follower') {
        timer.clear();
        deps.setStatus('live');
        return;
      }
      deps.setStatus('starting');
      wait(url);
    },
  };
}

function disconnectQuietly(port: ChromeRuntimePort | null): void {
  try {
    port?.disconnect();
  } catch {}
}

export function createSidePanelController(deps: SidePanelDeps): SidePanelController {
  let handle: SliccHandle | null = null;
  let currentJoinUrl: string | null = null;
  let disposed = false;
  let port: ChromeRuntimePort | null = null;
  let reconnectAttempt = 0;
  const bootTimer = oneShotTimer();
  const iframeLoadTimer = oneShotTimer();
  const seven = sevenFrame(deps, () => !disposed);
  let bootSlow = false;

  const blankIframe = () => {
    deps.iframe.setAttribute('src', 'about:blank');
  };
  const showSeven = (url: string) => {
    if (seven.url() === url) return;
    teardown();
    seven.show(url);
  };
  const teardown = () => {
    seven.leave();
    bootTimer.clear();
    bootSlow = false;
    iframeLoadTimer.clear();
    handle?.destroy();
    handle = null;
    currentJoinUrl = null;
    blankIframe();
  };
  const goDisconnected = () => {
    teardown();
    deps.setStatus('disconnected');
  };

  const onIframeLoad = () => {
    if (deps.iframe.getAttribute('src') === 'about:blank') return;
    iframeLoadTimer.clear();
    nudgeIframeRepaint(deps.iframe);
  };
  deps.iframe.addEventListener('load', onIframeLoad);
  const view = deps.iframe.ownerDocument?.defaultView;
  const onFrameMessage = (event: MessageEvent) => controller.frameMessage(event);
  view?.addEventListener('message', onFrameMessage);
  deps.iframe.addEventListener('error', () => {
    if (!disposed && handle) goDisconnected();
  });

  const requestLeaderFocus = (openSettings: boolean) => {
    try {
      port?.postMessage({ kind: 'focus-leader', openSettings });
    } catch {}
  };

  const onMessage = (raw: unknown) => {
    const msg = raw as SwToPanelMessage;
    if (msg?.kind === 'seven') {
      reconnectAttempt = 0;
      showSeven(msg.url);
      return;
    }
    if (msg?.kind !== 'join-url') return;

    if (msg.state === 'booting') {
      if (seven.url()) return;
      if (handle) {
        deps.setStatus('live');
        return;
      }
      if (bootSlow) {
        deps.setStatus('slow');
        return;
      }
      deps.setStatus('starting');
      bootTimer.start(BOOT_TIMEOUT_MS, () => {
        if (disposed) return;
        bootSlow = true;
        deps.setStatus('slow');
      });
      return;
    }

    if (msg.state === 'disconnected') {
      goDisconnected();
      return;
    }

    reconnectAttempt = 0;
    bootTimer.clear();
    bootSlow = false;
    if (msg.joinUrl === currentJoinUrl && handle) {
      deps.setStatus('live');
      return;
    }
    seven.leave();
    handle?.destroy();
    handle = null;
    blankIframe();
    currentJoinUrl = msg.joinUrl;
    iframeLoadTimer.start(IFRAME_LOAD_TIMEOUT_MS, () => {
      if (!disposed && handle) goDisconnected();
    });
    handle = deps.mountSlicc({
      iframe: deps.iframe,
      joinToken: msg.joinUrl,
      uiOnly: true,
      sliccOrigin: deps.sliccOrigin,
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      features: SIDE_PANEL_FEATURES satisfies CherryFeatures,
      hooks: {
        onSliccEvent: (name) => {
          if (name === 'slicc.open-leader-tab') requestLeaderFocus(true);
          if (name === 'slicc.focus-leader-tab') requestLeaderFocus(false);
        },
      },
    });
    deps.setStatus('live');
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
      setTimeout(
        () => {
          if (!disposed) wire();
        },
        nextBackoffDelayMs({ attempt: reconnectAttempt, baseMs: 250, capMs: 5000 })
      );
      reconnectAttempt += 1;
    });
    try {
      port.postMessage({ kind: 'hello' });
    } catch {}
  };

  wire();

  const controller: SidePanelController = {
    focusLeader: () => requestLeaderFocus(false),
    frameMessage: (event) => seven.said(event),
    retry() {
      if (disposed) return;
      disconnectQuietly(port);
      port = null;
      reconnectAttempt = 0;
      wire();
    },
    dispose() {
      disposed = true;
      teardown();
      deps.iframe.removeEventListener('load', onIframeLoad);
      view?.removeEventListener('message', onFrameMessage);
      disconnectQuietly(port);
    },
  };
  return controller;
}

if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
  const iframe = document.getElementById('cherry-follower') as HTMLIFrameElement;
  const statusEl = document.getElementById('cherry-status');
  const statusText = document.getElementById('cherry-status-text');
  const actionButton = document.getElementById('cherry-status-action') as HTMLButtonElement | null;
  let current: PanelStatus = 'starting';
  const setStatus = (s: PanelStatus) => {
    current = s;
    if (!statusEl) return;
    if (statusText) statusText.textContent = PANEL_STATUS_TEXT[s];
    if (actionButton) {
      const label = PANEL_ACTION_LABEL[s];
      actionButton.hidden = !label;
      actionButton.textContent = label ?? '';
    }
    statusEl.dataset.state = s;
  };
  const controller = createSidePanelController({
    connect: () => chrome.runtime.connect({ name: CHERRY_PANEL_PORT_NAME }),
    mountSlicc,
    iframe,
    setStatus,
    sliccOrigin: sliccOriginDefault,
  });
  actionButton?.addEventListener('click', () => {
    if (current === 'disconnected') controller.retry();
    else controller.focusLeader();
  });
}
