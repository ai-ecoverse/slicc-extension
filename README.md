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

- **`cert-review` commit status.** `.github/workflows/cert-review.yml` runs on `pull_request_target`, so the workflow, the prompt (`scripts/cert/review.txt`) and the scripts always come from main, and a pull request can't change its own certification. It never checks out or runs the pull request's code. It reads the diff with git as data. The result is a commit status named `cert-review` on the head SHA, posted by GitHub Actions and linked to the run attempt, always `success` or `failure`. It is a commit status, not a check run, because GitHub attaches a check run created with `GITHUB_TOKEN` to an older check suite, and the ruleset then reports the required check as expected:
  - fork heads, pull requests into a branch other than main, drafts, diffs too large to read in full, and cert-path changes without the coordinator's `cert-review-approved` label (cert-self-guard v1.24.2; the paths are every workflow, `.github/actions/`, `scripts/cert/`, `scripts/gate.mjs`, `scripts/is-main.mjs`) fail without a review;
  - a change that touches only `test/` or Markdown outside `extension/` and `six/` passes as `not behaviour` (the zip packs only `extension/`, built from `six/`, `scripts/` and the lockfile);
  - everything else gets a Claude review on Bedrock against the extension's cert rules.
- **Review, then post.** The review job has a read-only token and the Bedrock key, and Claude has Read, Glob and Grep only, scoped to main's tree and the diff (`--permission-mode dontAsk`). It returns a structured verdict in a closed schema (`scripts/cert/verdict.schema.json`). A separate job validates the verdict, binds it to the head and to its artifact by id and digest, and scans added lines for prompt-injection text (docs-only changes too). It fails shipped files git can only show as binary. It withholds a verdict that carries a secret this run holds or a known token prefix, and redacts other long mixed-case strings in place (integrity values such as `sha512-…` and hex stay readable). It fails if anything else has set a `cert-review` status or check run on the head, and opens an alert issue. Only then does it post the review. That job holds `statuses: write` and `pull-requests: write`; Claude never does. On a failure the review is REQUEST_CHANGES, with each finding on its diff line. Anything missing, unparseable or inconsistent is a failure.
- **Merge queue.** On `merge_group` a code-only job sets `cert-review` on the group head. It passes only if, for every member's head, the newest run of this workflow is a completed `pull_request_target` run for that pull request into main, and its `cert / post` job succeeded. The group job also fails if any `cert-review` status or check run on the group head or on a member head wasn't written by this workflow.
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
