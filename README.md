# slicc-extension

Chrome MV3 extension that serves both six (the hosted leader tab on `www.sliccy.ai`) and seven (SLICC pages on `*.sliccy.ai`). It lifts CORS, relays fetch requests, proxies the Chrome debugger, manages secrets, and provides the side panel UI.

## Seven — CORS lifting and relay

1. **Rules.** A static `declarativeNetRequest` rule ([`extension/rules.json`](extension/rules.json)) adds `Access-Control-Allow-Origin: *`, `-Methods: *`, `-Headers: *, authorization` and `-Expose-Headers: *` to every `fetch`/XHR response, preflights included, of requests that a page on `sliccy.ai` or a subdomain starts.
2. **The relay.** `globalThis.sliccExtension.fetch` sends the request from the extension's service worker, which CORS doesn't apply to. That covers preflights the upstream answers with a non-2xx status and the request headers a page can't send. It always omits credentials, and the headers a page can't send go only to the request's own origin, not across a cross-origin redirect.
3. **Redirects.** `sliccExtension.fetch(url, { redirect })` takes the three `fetch` modes. `follow`, the default, follows redirects and sets `response.url` and `response.redirected`. `error` rejects on any redirect. `manual` takes exactly one hop and resolves with the real 3xx status, its headers and an empty body. The worker's own `fetch` only gets an opaque response there, so it reads the head from `chrome.webRequest`; if that head can't be observed or is ambiguous, `manual` rejects with a `TypeError`. Responses that aren't redirects pass through as usual. Any other mode rejects with a `TypeError` before anything is sent.

## Seven — Chrome debugger

`sliccExtension.cdp` is a CDP command surface on the `slicc-fetch` port. The service worker accepts the port only when `trusted()` passes. Opening, attaching and navigating refuse protected origins (from `@ai-ecoverse/slicc-browsers` 1.5.0). Protected origins include all `*.sliccy.ai` hosts and `vault.sliccy.ai` specifically.

All tabs on one CDP connection share a 64 MiB retained-byte limit for script metadata, cached script events and held pause data. A debugger owner that would exceed it drops its records and resumes privately; commit and drop release its bytes, and the next ordinary document can start again.

Successful `sliccExtension.frames(tabId)` calls return a URL-free placement snapshot for an attached tab. A protected cross-process iframe refuses with `slicc: refused: unsettled frame list` instead of returning a snapshot; the worker's child-target closure check rejects it before serialization. Version 2 contains `revision`, `rootFrameId`, `rootLoaderId`, `frames` with numeric `frameId`, `parentFrameId` and a worker-computed `kind` (`ordinary`, `protected`, `error` or `unknown`), `localFrames` and `remoteOwners` with `frameId` and `backendNodeId`. Identifiers and owner records are included only when every frame is ordinary. Otherwise each frame carries only its kind, `rootFrameId` is omitted, and `localFrames` and `remoteOwners` are empty; revision and root loader generation stay. This also prevents a descendant parent ID from naming a protected frame. Counts are the lengths of the lists and are used for placement only on an all-ordinary reply. The worker checks the current generation and complete native frame closure before replying and classifies origins with its existing protected matcher. URLs, origins and native document IDs never leave the worker on this API; root identity uses the verified frame and loader IDs. Replies use their dedicated channel and never reach `cdp.on` listeners. Missing, stale or incomplete placement evidence still refuses.

Same-origin child frame tools list and call on the extension route.

## Six — hosted leader tab

The extension manages a pinned leader tab at `https://www.sliccy.ai/?slicc=leader`. The leader tab connects via `externally_connectable` and gets:
- **CDP bridge** (`slicc.cdp-bridge` port): full `chrome.debugger` pass-through with three-factor pin (origin allowlist + tab id + top frame).
- **Fetch proxy** (`fetch-proxy.fetch` port): secret-injected fetch with S3 SigV4 and DA sign-and-forward, forbidden header restoration via session DNR rules.
- **Secrets CRUD** (`secrets.crud` port): chrome.storage-backed secret management.
- **Sign-and-forward** (`mount.sign-and-forward`): S3/DA mount signing.

## Six — side panel

The side panel (`sidepanel.html`) mounts a cherry follower iframe that connects to the leader tab's tray. The controller manages boot, ready, and disconnected states with automatic reconnection.

## Seven on www — leader tab and side panel

After the in-place upgrade (slicc-bios#648), seven's service worker answers `www.sliccy.ai/?slicc=leader` with a redirect to `/os/`, so the leader tab ends up on seven.
- **The upgrade, as the extension sees it:** the extension's own leader URL (`?slicc=leader&ext=<id>`) starts a top-frame navigation, and the navigation commits on `/os/` with `server_redirect` in `webNavigation`'s transition qualifiers. Seven's service worker and a network 302 both count. The extension then sets `slicc_seven_upgraded` in `chrome.storage.local`, which only the extension's own pages and worker can read and write (`TRUSTED_CONTEXTS`). The upgrade is one-way per browser. A script navigation (`location.assign('/os/')`), a redirect from another URL (`/7` to `/7/`) and a `pushState` are no upgrade.
- **The leader:** a `?slicc=leader` tab always wins. Before the upgrade, the extension never adopts a seven tab and creates a six leader instead. After it, a `www.sliccy.ai` tab whose committed URL is on `/os/` or `/7/` is the leader: the stored tab first, then a pinned one, then a loaded one. It's adopted as it is, without changing its URL or pinning it, and other seven tabs stay open. Before this change, every panel open created another leader tab. A `pendingUrl` never counts.
- **Leaving the leader document:** every top-frame commit in the stored tab is checked. A six leader URL keeps it as six. Seven keeps it as seven only after the upgrade. Anything else, `/preview/` included, drops the stored leader and tells the panel.
- **Six's ports never reach seven:** the CDP bridge, `fetch-proxy.fetch`, `secrets.crud` and `mount.sign-and-forward` refuse:
  - a sender on `/os/`, `/7` or `/7/` (`leader-is-seven`);
  - any sender while the stored leader is seven (`leader-is-seven`);
  - a sender whose document didn't commit on a six leader URL (`not-leader-document`).

  The last check uses the sender's `documentId` against the commit the extension saw for that tab, so a page that `pushState`s a leader URL is refused. A commit made before the worker listened (a browser start, an update) is checked with `webNavigation.getFrame`.
- **The panel:** when the leader is seven, the service worker sends the panel `{ kind: 'seven', url: 'https://www.sliccy.ai/os/' }`, both when the panel connects and when the leader's upgrade redirect commits. The panel frames that URL in place of cherry. Seven lets only this extension's id frame `/os/`, runs there as a follower tab of the one that owns the kernel, and never takes the kernel itself (ai-ecoverse/slicc-bios#1530). The panel accepts `{ type: 'slicc-seven-panel', role }` only from that frame's window and origin, and shows it once `role` is `follower`.
- **Fallback:** a seven that doesn't answer within 20 s (an older seven, which refuses the frame) leaves the panel on *SLICC runs in its tab* with **Show SLICC tab**, which brings the leader tab to the front.
- **Tests:** `seven-panel.test.mjs`, against a fake www that redirects the leader, once by a service worker and once by a 302 when `__Host-slicc-six-retired` is set. It covers:
  - before the upgrade, the forgeries above, and a seven tab never adopted;
  - after the upgrade, every pinned port refusing the seven leader, on `/os/`, on `/7/` and after it moves to `/preview/`;
  - the panel ignoring a message of another type, from another origin, or from its own window.

## Six — secrets

The secrets options page (`secrets.html`) manages named secrets with per-domain scoping, S3 profiles, and OAuth extra domains. Secrets are encrypted with AES-GCM and kept as records in IndexedDB; older plaintext and `{ct, iv}` entries in `chrome.storage.local` migrate on first access.

## Adobe sign-in

`sliccExtension.signIn({ clientId, scopes, imsEnvironment })` signs in to Adobe IMS with `chrome.identity.launchWebAuthFlow`.

## Handshake

At `document_start` on `https://*.sliccy.ai/*` the extension defines a frozen `globalThis.sliccExtension` in the page's own world.

Hosts whose label is in `seven.excludedLabels` or starts with one of `seven.excludedLabelPrefixes` in the pinned `@ai-ecoverse/slicc-browsers` catalog get no content scripts and no CDP port, except `www.sliccy.ai` for six. `scripts/build-seven.mjs` writes those lists into the manifest's `exclude_matches` and `exclude_globs`, and into the generated `seven.js`, `seven-gate.js`, `seven-gate-main.js` and `protected-rules.js`. In CI the build fails if the committed manifest is out of date.

## PRE-1 origin protection

Protected origins (from slicc-browsers 1.5.0):

| Origin                     | Content scripts | Relay fetch |     CDP (content script)      |     CDP (bridge)     | Side panel | Secrets |
| -------------------------- | :-------------: | :---------: | :---------------------------: | :------------------: | :--------: | :-----: |
| www.sliccy.ai              |        ✓        |      ✓      | ✓ (protected targets blocked) | ✓ (three-factor pin) |     ✓      |    ✓    |
| seven.sliccy.ai            |        ✓        |      ✓      | ✓ (protected targets blocked) |          —           |     —      |    —    |
| vault.sliccy.ai            |        ✓        |      ✓      | ✓ (protected targets blocked) |          —           |     —      |    —    |
| Branch hosts (*.sliccy.ai) |        ✓        |      ✓      | ✓ (protected targets blocked) |          —           |     —      |    —    |
| External sites             |        —        |      —      |               —               |          —           |     —      |    —    |

Both six's bridge CDP and seven's content-script CDP refuse to target protected origins. Six's pages cannot get CDP or relay access to seven's or the vault's tabs. Seven's relay keeps refusing protected targets.

## Development

```bash
npm run build
npm test
npm run pack
```

`npm run build` bundles six's TypeScript source in `six/` into `extension/six-sw.js`, `sidepanel.js`, and `secrets.js` with esbuild. It fetches nothing, and a rebuild is byte-identical (`rebuild.test.mjs` checks it). `npm run typecheck` checks `six/`. `npm test` runs integration tests. `npm run pack [version]` writes `artifacts/slicc-extension.zip`. The manifest carries the production `key`, so the unpacked extension has Chrome Web Store ID `akjjllgokmbgpbdbmafpiefnhidlmbgf`.

## CI and releases

`.github/workflows/ci.yml` is the only caller of [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) (`pipeline.yml@v2.8.4`, matching the `@ai-ecoverse/slicc-shared-web` devDependency). Require `ci / integration` and `ci / review`.
- **Pull requests and the merge queue:** `slicc-lint` (Biome, `typecheck` and the shared rules), then the files in `test/integration/*.test.mjs` split by timing over 4 shards, each running `npm test` (which builds first), then on a pull request the Claude and Codex reviews. Chrome runs headed on CI, each browser on its own Xvfb display, and headless locally; `SLICC_HEADLESS=1` or `0` overrides.
- **The guard sweep:** `guard-<transport>-<variant>.test.mjs` runs the pinned `@ai-ecoverse/slicc-browsers` guard vectors on `seven` and `six-bridge`, `prompt` and `lagging`, `GUARD_PARALLEL` rows at a time (4 by default). Each file fails unless every row passes or skips for a known reason, with no all-skip run and no failed, incomplete, forged or missing row, and prints its `GUARD-PASS` line. The rows go to `artifacts/guard/<transport>-<variant>.json`, which the reviewers get.
- **`main`:** semantic-release builds and packs `artifacts/slicc-extension.zip`, checks it with `scripts/check-live-permissions.mjs` and `scripts/check-six-floor.mjs`, and attaches it to the GitHub release. When a new `v*` tag points at the commit, the `cws` job checks the six floor again and publishes that zip with `scripts/cws-publish.mjs`, which refuses any version not newer than the store's.
- **Store verify.** `.github/workflows/cws-verify.yml` runs hourly on main. It checks that the crx the Chrome Web Store serves, minus `_metadata/` and the `update_url` line the store inserts, is byte-identical to the `slicc-extension.zip` of the release with that version. It also checks that this zip matches a rebuild from the release's tag, and that the tag is on main. It sets a `cws-verify` check run on the tag commit and fails on any difference.

## Six source

`six/extension/` is slicc's `packages/chrome-extension/src` and `six/shared-ts/` the `packages/shared-ts` modules it reaches, both imported from the slicc commit in [`six/upstream.json`](six/upstream.json) and edited here from then on. [`six/manifest.json`](six/manifest.json) is that release's manifest, the permission baseline when the live listing is unreachable; `six/upstream.json` pins its sha256. `@slicc/shared-ts` resolves through `paths` in `tsconfig.json`, which esbuild reads too; cherry is the exact-pinned npm package `@ai-ecoverse/cherry`, bundled at build time.

`CHROME_WEB_STORE_MODE` defaults to `publish`, which uploads and submits the release. Set the repository variable to `upload` to upload a draft without submitting it, then fill in the permission justifications in the store dashboard. Unset the variable and re-run the release’s `cws` job to upload and publish; the API documentation does not confirm that replacing an unsubmitted draft with the same version is allowed, so if the store refuses the repeated upload, submit the existing draft in the dashboard. Other mode values are rejected.

Releases roll forward only. Before publishing, `scripts/check-six-floor.mjs` refuses a release based on an older six than the live listing carries. Once the live build comes from `six/`, it refuses legacy `(six vX)` builds and any release that isn't newer than the live one, and `scripts/cws-publish.mjs` checks the version against the store again.

## Permissions

| Permission                            | Used by | Justification                                           |
| ------------------------------------- | ------- | ------------------------------------------------------- |
| `debugger`                            | Both    | CDP proxy for seven pages and six bridge                |
| `alarms`                              | Seven   | Wakes the service worker to detach a stuck debugger session |
| `tabs`                                | Six     | Leader tab management, tab queries for bridge CDP       |
| `tabGroups`                           | Six     | Tab group management for leader tab                     |
| `identity`                            | Both    | Adobe IMS sign-in via launchWebAuthFlow                 |
| `storage`                             | Six     | Secrets storage in chrome.storage.local                 |
| `webRequest`                          | Both    | Handoff Link headers, discovery, relay redirect heads   |
| `declarativeNetRequestWithHostAccess` | Both    | Static CORS rules + session rules for forbidden headers |
| `notifications`                       | Six     | Handoff notification toasts                             |
| `sidePanel`                           | Six     | Cherry follower side panel                              |
| `<all_urls>` (host)                   | Both    | Relay fetch to any URL, DNR rules for any upstream      |
