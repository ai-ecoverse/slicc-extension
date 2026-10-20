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

| Origin | Content scripts | Relay fetch | CDP (content script) | CDP (bridge) | Side panel | Secrets |
|--------|:-:|:-:|:-:|:-:|:-:|:-:|
| www.sliccy.ai | ✓ | ✓ | ✓ (protected targets blocked) | ✓ (three-factor pin) | ✓ | ✓ |
| seven.sliccy.ai | ✓ | ✓ | ✓ (protected targets blocked) | — | — | — |
| vault.sliccy.ai | ✓ | ✓ | ✓ (protected targets blocked) | — | — | — |
| Branch hosts (*.sliccy.ai) | ✓ | ✓ | ✓ (protected targets blocked) | — | — | — |
| External sites | — | — | — | — | — | — |

Both six's bridge CDP and seven's content-script CDP refuse to target protected origins. Six's pages cannot get CDP or relay access to seven's or the vault's tabs. Seven's relay keeps refusing protected targets.

## Development

```bash
npm run build
npm test
npm run pack
```

`npm run build` bundles six's TypeScript source in `six/` into `extension/six-sw.js`, `sidepanel.js`, and `secrets.js` with esbuild. It fetches nothing, and a rebuild is byte-identical. `npm run typecheck` checks `six/`. `npm test` runs integration tests. `npm run pack [version]` writes `artifacts/slicc-extension.zip`. The manifest carries the production `key`, so the unpacked extension has Chrome Web Store ID `akjjllgokmbgpbdbmafpiefnhidlmbgf`.

## Certification

Every pull request is certified in the pull request, and a release needs nothing more: merged on main means certified.

- **`cert-review` commit status.** `.github/workflows/cert-review.yml` calls slicc-shared-web's reusable cert-review workflow (v1.29.1, pinned by sha, with `tools-ref` set to the same sha) on `pull_request_target` and `merge_group`. The caller, the shared tools and the rules all come from main, so a pull request can't change its own certification, and no pull-request code runs. The result is a commit status named `cert-review` on the head, posted by GitHub Actions and linked to the run attempt, always `success` or `failure`. The org ruleset requires this caller at `refs/heads/main`, and the branch ruleset requires `cert-review` from GitHub Actions. slicc-shared-web's README describes the jobs, the verdict schema, the second-writer check, the injection scan and the merge group.
- **This repository's inputs.**
  - The rules: `scripts/cert/review.txt`, this extension's section of the shared prompt (protected origins, the guard on both transports, internal messages and secrets, CORS and the relay, permissions and CWS packaging, the build and supply chain).
  - Behaviour: `extension/**` and `six/**` always count. Otherwise a change that touches only `test/` or Markdown passes as `not behaviour`.
  - Guard paths: every workflow, `.github/actions/`, `scripts/cert/`, `scripts/gate.mjs` and `scripts/is-main.mjs`. A change to them needs the coordinator's `cert-review-approved` label on the current head.
  - Evidence: the review reads the `guard-rows` artifact of the pull request's own `ci.yml` run and of main's, bound by id and digest. It waits up to two hours for that run. Re-run all of a failed `ci.yml` run, not only its failed jobs: an artifact from an earlier attempt doesn't count, so a partial re-run leaves cert-review `incomplete: evidence`.
- **Re-run after labelling or marking ready.** `.github/workflows/cert-rerun.yml` calls the shared cert-rerun workflow. Under the org rule, GitHub starts cert-review only on opened, synchronize and reopened, so cert-rerun re-runs the newest cert-review run on the head when a pull request is marked ready, gets or loses the approval label, or moves its base to main. It has `actions: write` only and never writes `cert-review`. To re-run by hand, use `gh api -X POST repos/ai-ecoverse/slicc-extension/actions/runs/<id>/rerun`; `gh run rerun` can't find required-workflow runs.
- **Store verify.** `.github/workflows/cws-verify.yml` runs hourly on main. It checks that the crx the Chrome Web Store serves, minus `_metadata/` and the `update_url` line the store inserts, is byte-identical to the `slicc-extension.zip` of the release with that version. It also checks that this zip matches a rebuild from the release's tag, and that the tag is on main. It sets a `cws-verify` check run on the tag commit and fails through `scripts/gate.mjs` on any difference.

## Six source

`six/extension/` is slicc's `packages/chrome-extension/src` and `six/shared-ts/` the `packages/shared-ts` modules it reaches, both imported from the slicc commit in [`six/upstream.json`](six/upstream.json) and edited here from then on. [`six/manifest.json`](six/manifest.json) is that release's manifest, the permission baseline when the live listing is unreachable; `six/upstream.json` pins its sha256. `@slicc/shared-ts` resolves through `paths` in `tsconfig.json`, which esbuild reads too; cherry is the exact-pinned npm package `@ai-ecoverse/cherry`, bundled at build time.

Releases roll forward only. Before publishing, `scripts/check-six-floor.mjs` refuses a release based on an older six than the live listing carries. Once the live build comes from `six/`, it refuses legacy `(six vX)` builds and any release that isn't newer than the live one, and `scripts/cws-publish.mjs` checks the version against the store again.

## Permissions

| Permission | Used by | Justification |
|-----------|---------|---------------|
| `debugger` | Both | CDP proxy for seven pages and six bridge |
| `tabs` | Six | Leader tab management, tab queries for bridge CDP |
| `tabGroups` | Six | Tab group management for leader tab |
| `identity` | Both | Adobe IMS sign-in via launchWebAuthFlow |
| `storage` | Six | Secrets storage in chrome.storage.local |
| `webRequest` | Six | Handoff Link header observation, discovery |
| `declarativeNetRequestWithHostAccess` | Both | Static CORS rules + session rules for forbidden headers |
| `notifications` | Six | Handoff notification toasts |
| `sidePanel` | Six | Cherry follower side panel |
| `<all_urls>` (host) | Both | Relay fetch to any URL, DNR rules for any upstream |
