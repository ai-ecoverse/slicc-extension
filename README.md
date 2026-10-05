# slicc-extension

Empty Chrome MV3 extension scaffold for SLICC. It will lift CORS for `sliccy.ai` origins. Migrate from SLICC's `packages/chrome-extension`.

```bash
npm run pack
```

That writes `artifacts/slicc-extension.zip`. `npm run lint` runs `slicc-lint`. Releases attach the zip to the GitHub release. No npm package and no Chrome Web Store publish yet.
