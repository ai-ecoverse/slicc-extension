# slicc-extension

Chrome MV3 extension that gives SLICC pages on `*.sliccy.ai` the whole web by lifting CORS for them. It has no UI.

## How it lifts CORS

1. **Rules.** A static `declarativeNetRequest` rule ([`extension/rules.json`](extension/rules.json)) adds `Access-Control-Allow-Origin: *`, `-Methods: *`, `-Headers: *, authorization` and `-Expose-Headers: *` to every `fetch`/XHR response, preflights included, of requests that a page on `sliccy.ai` or a subdomain starts. A plain `fetch(url, { credentials: 'omit' })` then reads any upstream, and so does the kernel's `fetchTransport()`.
2. **The relay.** Rules can't help with everything else, so `globalThis.sliccExtension.fetch` sends the request from the extension's service worker, which CORS doesn't apply to. That covers:
   - preflights the upstream answers with a non-2xx status (GitHub's git endpoints, `example.com` and most servers answer `OPTIONS` with `405`);
   - the request headers a page can't send: `User-Agent`, `Cookie`, `Referer` and `Origin` go out as the program set them (through a one-off session rule per request), and no `Origin` goes out when it set none.

What neither does:
- **Requests with credentials:** the browser's cookie jar is never sent; the rules answer `*`, and the relay fetches with `credentials: 'omit'`.
- **`Set-Cookie`:** responses never show it, because Chrome hides it from pages and from extension service workers alike.

## Handshake

At `document_start` on `https://*.sliccy.ai/*` the extension defines a frozen `globalThis.sliccExtension` in the page's own world, so the page knows synchronously, before any of its scripts run, whether the extension is there:

```js
import { fetchTransport } from '@ai-ecoverse/slicc-kernel';

const transport = globalThis.sliccExtension
  ? fetchTransport({ fetch: globalThis.sliccExtension.fetch })
  : fetchTransport();
```

`sliccExtension.fetch(input, init)` takes a URL and the `method`, `headers`, `body` and `signal` of `init`, and answers a streaming `Response`. It rejects with a `TypeError` when the upstream is unreachable and with the signal's reason when aborted. When `sliccExtension` is there, the rules above are active too.

The relay runs page → content script (a `MessagePort`) → service worker (a `chrome.runtime` port per request) → upstream. The body is pulled, one chunk per read, so a slow reader slows the download instead of filling memory. A body such as `FormData` keeps the `Content-Type` it brings unless the caller sets one. The service worker only accepts ports from content scripts in `https://` frames on `sliccy.ai`.

## Adobe sign-in

`sliccExtension.signIn({ clientId, scopes, imsEnvironment })` signs in to Adobe IMS with `chrome.identity.launchWebAuthFlow` and answers the access token. The service worker builds the authorize URL itself, for `ims-na1.adobelogin.com` (or `ims-na1-stg1` when `imsEnvironment` is `stg1`), with the extension's redirect `https://akjjllgokmbgpbdbmafpiefnhidlmbgf.chromiumapp.org/adobe` and a fresh `state`, and rejects any answer that comes back elsewhere or carries another `state`. It takes requests only from content scripts in `https://` frames on `sliccy.ai`, the same as the relay, so the token never goes to another origin. It rejects with IMS's `error_description` (or `error`) when the user refuses.

## Chrome debugger

`sliccExtension.cdp` is a CDP command surface on that same port. `cdp.send(method, params, sessionId)` answers the command result, and `cdp.on(listener)` receives events as `{ method, params, sessionId }`. The service worker accepts the port only when `trusted()` passes: the sender is this extension, and the frame is `https://sliccy.ai` or `https://*.sliccy.ai`. There is no other gate.

`Target.getTargets` lists tabs. `targetId` is the tab id. `Target.createTarget` opens a background tab, or a new window when `newWindow` is true. `Target.closeTarget` closes that tab. `Target.activateTarget` selects it and focuses its window. `Target.attachToTarget` must be `{ targetId, flatten: true }`. Any other `flatten` value returns `only flatten: true is supported` and does not attach. The returned `sessionId` is that `targetId`. Later commands pass it as a top-level `sessionId`, and only the port that attached it may use it. `chrome.debugger` events for the tab are posted back on that port with the same `sessionId`. `Page.bringToFront` also selects the tab, because `chrome.debugger` alone does not. `Target.detachFromTarget`, `Target.closeTarget`, and a port disconnect release the debugger when this port's last attach to that tab is gone.

## Development

```bash
npm test
npm run pack
```

`npm test` runs the integration tests in [`test/integration/`](test/integration/) through the [harness from slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web#integration-test-harness): Chromium with the unpacked extension, `--host-resolver-rules` mapping `seven.sliccy.ai` and a CORS-less `upstream.test` to local HTTPS servers. It writes coverage of `extension/` to `coverage/` and CPU profiles, screenshots, console logs and `hotspots.md` to `artifacts/`, which `npm test` clears, so run `npm run pack` after it. `npm run pack [version]` writes `artifacts/slicc-extension.zip`, with `version` stamped into its `manifest.json`. Each release runs it with the semantic-release version and attaches the zip to its GitHub release. The manifest carries the production `key`, so the unpacked extension has the Chrome Web Store ID `akjjllgokmbgpbdbmafpiefnhidlmbgf`. `npm run lint` runs `slicc-lint`. To try it, load `extension/` unpacked in `chrome://extensions`. There is no npm package and no Chrome Web Store listing yet.
