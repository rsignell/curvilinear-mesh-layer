# icechunk-js Migration Design

**Date:** 2026-05-07
**Status:** Approved

## Problem

The COAWST icechunk store was rewritten with Python icechunk v2.0.4 (v2 binary format). The current viewer uses `@earthmover/icechunk` v2.0.3, which requires a hand-rolled `createIcechunkV2FetchStorage` adapter to speak the v2 protocol. This adapter is incomplete — the viewer fails to load data.

The JS developer at Earthmover confirmed that `icechunk-js` (a separate pure-TypeScript library from EarthyScience) correctly handles v2 stores and is exactly the pattern used by the CarbonPlan zarr-layer demo.

## Solution

Replace `@earthmover/icechunk` (WASM-based) with `icechunk-js` (pure TypeScript). This eliminates the custom storage adapter, all WASM build plumbing, and the CI curl workaround.

## Architecture

### New data flow

```
icechunk-js IcechunkStore.open(url, { branch: 'main' })
  → auto-detects v2 format, translates s3:// → https:// for virtual chunks
zarrita open(store.resolve(path)) + get(arr, selection)
  → unchanged
inferCornersFromCenters() + tessellateTriangles()
  → unchanged
CurvilinearTriangleLayer → MapLibre GL JS
  → unchanged
```

### Key API change

Before (broken):
```js
import { Repository } from '@earthmover/icechunk';
import { createIcechunkV2FetchStorage } from './icechunk_v2_fetch_storage.js';

const storage = createIcechunkV2FetchStorage(ICECHUNK_URL);
const repo = await Repository.open(storage, undefined, {
  'https://usgs-coawst.s3.us-west-2.amazonaws.com/': null,
});
const session = await repo.readonlySession({ branch: 'main' });
zarrStore = session.store;
```

After:
```js
import { IcechunkStore } from 'icechunk-js';

zarrStore = await IcechunkStore.open(ICECHUNK_URL, { branch: 'main' });
```

`IcechunkStore` implements zarrita's `AsyncReadable` interface directly. All downstream `zarrOpen` / `zarrGet` calls are unchanged.

`icechunk-js` translates `s3://usgs-coawst/...` virtual chunk references to `https://usgs-coawst.s3.amazonaws.com/...` automatically via its `translateToHttpUrl` function — no `authorizeVirtualChunkAccess` equivalent needed.

## File Changes

### Delete
- `src/icechunk_v2_fetch_storage.js` — replaced by `icechunk-js` internals
- `inspect_manifest.mjs`, `inspect_manifest2.mjs`, `inspect_manifest3.mjs`, `inspect_manifest4.mjs`, `inspect_manifest5.mjs` — debug scripts no longer needed
- `patches/` — WASM patch artifacts
- `stubs/` — WASM stub overrides for CI

### Update: `package.json`
- Replace `@earthmover/icechunk` with `icechunk-js` in `dependencies`
- Remove `@napi-rs/wasm-runtime`, `@emnapi/core`, `@emnapi/runtime` from `dependencies`
- Remove `@earthmover/icechunk-wasm32-wasi` from `optionalDependencies`
- Remove `vite-plugin-wasm` and `vite-plugin-top-level-await` from `devDependencies`

### Update: `src/main.js`
- Replace `import { Repository } from '@earthmover/icechunk'` with `import { IcechunkStore } from 'icechunk-js'`
- Remove `import { createIcechunkV2FetchStorage } from './icechunk_v2_fetch_storage.js'`
- Replace the `openStore()` function body (~15 lines) with `zarrStore = await IcechunkStore.open(ICECHUNK_URL, { branch: 'main' })`

### Update: `vite.config.js`
- Remove `import wasm from 'vite-plugin-wasm'` and `import topLevelAwait from 'vite-plugin-top-level-await'`
- Remove `plugins: [wasm(), topLevelAwait()]`
- Remove `optimizeDeps: { exclude: ['@earthmover/icechunk-wasm32-wasi'] }`
- Keep COOP/COEP headers (`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`) — deck.gl/luma.gl may still require `SharedArrayBuffer`

### Update: `.github/workflows/deploy.yml`
- Remove the `Install icechunk WASM package` step (the `curl` + `tar` workaround)
- Build step becomes plain `npm ci && npm run build`

### Unchanged
- `curvilinear_mesh_layer.js` — tessellation helpers
- `src/curvilinear_triangle_layer.js` — custom deck.gl triangle layer
- `index.html` — UI
- `src/main.js` render path — everything after `openStore()` / `loadGrid()`
- `test/curvilinear_mesh_layer.test.js` — pure-math tests, no icechunk dependency

## Testing

The existing Node.js unit tests (`test/curvilinear_mesh_layer.test.js`) cover `inferCornersFromCenters` and `tessellateTriangles` and pass unchanged.

End-to-end verification: run `npm run dev`, open the browser, load a variable. The Playwright smoke test on GitHub Pages (`npm run smoke:pages`) serves as the CI end-to-end check.

## Dependencies

- `icechunk-js` v0.4.0 — [npm](https://www.npmjs.com/package/icechunk-js) · [GitHub](https://github.com/EarthyScience/icechunk-js)
- Reference implementation: [carbonplan/zarr-layer demo](https://github.com/carbonplan/zarr-layer/blob/main/demo/datasets/icechunk.tsx)
</content>
