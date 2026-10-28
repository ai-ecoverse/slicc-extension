# slicc-extension

Chrome MV3 extension that serves both six (the hosted leader tab on `www.sliccy.ai`) and seven (SLICC pages on `*.sliccy.ai`). It lifts CORS, relays fetch requests, proxies the Chrome debugger, manages secrets, and provides the side panel UI.

## Seven — CORS lifting and relay

1. **Rules.** A static `declarativeNetRequest` rule ([`extension/rules.json`](extension/rules.json)) adds `Access-Control-Allow-Origin: *`, `-Methods: *`, `-Headers: *, authorization` and `-Expose-Headers: *` to every `fetch`/XHR response, preflights included, of requests that a page on `sliccy.ai` or a subdomain starts.
2. **The relay.** `globalThis.sliccExtension.fetch` sends the request from the extension's service worker, which CORS doesn't apply to. That covers preflights the upstream answers with a non-2xx status and the request headers a page can't send.

## Seven — Chrome debugger

`sliccExtension.cdp` is a CDP command surface on the `slicc-fetch` port. The service worker accepts the port only when `trusted()` passes. Opening, attaching and navigating refuse protected origins (from `@ai-ecoverse/slicc-browsers` 1.5.0). Protected origins include all `*.sliccy.ai` hosts and `vault.sliccy.ai` specifically.

## Six — hosted leader tab

The extension manages a pinned leader tab at `https://www.sliccy.ai/?slicc=leader`. The leader tab connects via `externally_connectable` and gets:
- **CDP bridge** (`slicc.cdp-bridge` port): full `chrome.debugger` pass-through with three-factor pin (origin allowlist + tab id + top frame).
- **Fetch proxy** (`fetch-proxy.fetch` port): secret-injected fetch with S3 SigV4 and DA sign-and-forward, forbidden header restoration via session DNR rules.
- **Secrets CRUD** (`secrets.crud` port): chrome.storage-backed secret management.
- **Sign-and-forward** (`mount.sign-and-forward`): S3/DA mount signing.

## Six — side panel

The side panel (`sidepanel.html`) mounts a cherry follower iframe that connects to the leader tab's tray. The controller manages boot, ready, and disconnected states with automatic reconnection.

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

Releases roll forward only. Before publishing, `scripts/check-six-floor.mjs` refuses a release based on an older six than the live listing carries. Once the live build comes from `six/`, it refuses legacy `(six vX)` builds and any release that isn't newer than the live one, and `scripts/cws-publish.mjs` checks the version against the store again.

## Permissions

| Permission                            | Used by | Justification                                           |
| ------------------------------------- | ------- | ------------------------------------------------------- |
| `debugger`                            | Both    | CDP proxy for seven pages and six bridge                |
| `tabs`                                | Six     | Leader tab management, tab queries for bridge CDP       |
| `tabGroups`                           | Six     | Tab group management for leader tab                     |
| `identity`                            | Both    | Adobe IMS sign-in via launchWebAuthFlow                 |
| `storage`                             | Six     | Secrets storage in chrome.storage.local                 |
| `webRequest`                          | Six     | Handoff Link header observation, discovery              |
| `declarativeNetRequestWithHostAccess` | Both    | Static CORS rules + session rules for forbidden headers |
| `notifications`                       | Six     | Handoff notification toasts                             |
| `sidePanel`                           | Six     | Cherry follower side panel                              |
| `<all_urls>` (host)                   | Both    | Relay fetch to any URL, DNR rules for any upstream      |
