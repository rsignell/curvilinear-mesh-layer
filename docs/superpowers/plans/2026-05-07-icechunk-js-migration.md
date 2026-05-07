# icechunk-js Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `@earthmover/icechunk` WASM library with `icechunk-js` (pure TypeScript) so the COAWST curvilinear grid viewer can load data from the Python v2.0.4 icechunk store.

**Architecture:** `IcechunkStore.open(url, { branch: 'main' })` from `icechunk-js` returns a zarrita-compatible `AsyncReadable` store directly — no custom storage adapter, no WASM, no `Repository`/`session` indirection. Everything downstream of store-opening (tessellation, deck.gl triangle layer, MapLibre UI) is untouched. Virtual chunks stored as `s3://usgs-coawst/...` are translated to HTTPS automatically by `icechunk-js` internals.

**Tech Stack:** `icechunk-js` v0.4.0, zarrita v0.7.x, Vite v6, deck.gl v9, MapLibre GL JS v4, Node.js built-in test runner

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `package.json` | Modify | Swap library; remove WASM deps |
| `src/main.js` | Modify | Replace `openStore()` body; fix imports |
| `vite.config.js` | Modify | Remove WASM plugins and `optimizeDeps`; keep COOP/COEP |
| `.github/workflows/deploy.yml` | Modify | Remove `curl` WASM install step |
| `src/icechunk_v2_fetch_storage.js` | Delete | Replaced by `icechunk-js` internals |
| `inspect_manifest*.mjs` (×5) | Delete | Debug artifacts |
| `patches/icechunk-js+0.4.0.patch` | Delete | WASM patch artifact |
| `stubs/icechunk-wasm32-wasi/` | Delete | WASM CI stub |
| `curvilinear_mesh_layer.js` | Unchanged | |
| `src/curvilinear_triangle_layer.js` | Unchanged | |
| `index.html` | Unchanged | |
| `test/curvilinear_mesh_layer.test.js` | Unchanged | |

---

## Task 1: Confirm baseline tests pass

**Files:** none modified

- [ ] **Step 1: Run the existing unit tests**

```bash
npm test
```

Expected output: all tests pass. These cover `inferCornersFromCenters` and `tessellateTriangles` — pure math, no icechunk dependency.

```
▶ inferCornersFromCenters
  ✔ corner values match bilinear extrapolation
  ...
▶ tessellateTriangles
  ✔ triangle winding is CCW
  ...
```

If tests fail here, stop and fix before proceeding — they should be green at baseline.

---

## Task 2: Swap the npm dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Edit `package.json`**

Replace the entire file with the following (preserves all non-WASM deps, adds `icechunk-js`):

```json
{
  "name": "curvilinear-mesh-layer",
  "version": "0.1.0",
  "description": "Browser visualization of 2D curvilinear ocean model grids (ROMS/COAWST) with deck.gl + icechunk-js",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "node --test",
    "preview": "vite preview",
    "smoke:pages": "node scripts/smoke-pages.mjs"
  },
  "dependencies": {
    "@luma.gl/engine": "^9.3.3",
    "bubblewrap": "^0.2.0",
    "deck.gl": "^9.3.2",
    "icechunk-js": "^0.4.0",
    "maplibre-gl": "^4.7.0",
    "playwright": "^1.59.1",
    "zarrita": "^0.7.2"
  },
  "devDependencies": {
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Install**

```bash
npm install
```

Expected: `icechunk-js` added to `node_modules`, no WASM platform warnings.

- [ ] **Step 3: Confirm tests still pass**

```bash
npm test
```

Expected: same green output as Task 1 baseline.

---

## Task 3: Update `src/main.js`

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Replace the two icechunk imports at the top of the file**

Find these lines (around line 14–23):

```js
import { Repository } from '@earthmover/icechunk';
import { open as zarrOpen, get as zarrGet, root as zarrRoot, slice } from 'zarrita';
import {
  inferCornersFromCenters,
  loadColorLUT,
  tessellateTriangles,
  dataRange,
} from '../curvilinear_mesh_layer.js';
import { buildTriangleLayer } from './curvilinear_triangle_layer.js';
import { createIcechunkV2FetchStorage } from './icechunk_v2_fetch_storage.js';
```

Replace with:

```js
import { IcechunkStore } from 'icechunk-js';
import { open as zarrOpen, get as zarrGet, root as zarrRoot, slice } from 'zarrita';
import {
  inferCornersFromCenters,
  loadColorLUT,
  tessellateTriangles,
  dataRange,
} from '../curvilinear_mesh_layer.js';
import { buildTriangleLayer } from './curvilinear_triangle_layer.js';
```

- [ ] **Step 2: Replace the `openStore()` function body**

Find this function (around line 94–104):

```js
async function openStore() {
  if (zarrStore) return zarrStore;
  setStatus('Opening icechunk store…');
  const storage = createIcechunkV2FetchStorage(ICECHUNK_URL);
  const repo = await Repository.open(storage, undefined, {
    'https://usgs-coawst.s3.us-west-2.amazonaws.com/': null,
  });
  const session = await repo.readonlySession({ branch: 'main' });
  zarrStore = session.store;
  return zarrStore;
}
```

Replace with:

```js
async function openStore() {
  if (zarrStore) return zarrStore;
  setStatus('Opening icechunk store…');
  zarrStore = await IcechunkStore.open(ICECHUNK_URL, { branch: 'main' });
  return zarrStore;
}
```

- [ ] **Step 3: Confirm tests still pass**

```bash
npm test
```

Expected: green. (The unit tests don't import `main.js`, so this is a quick sanity check that the file is still parseable.)

---

## Task 4: Simplify `vite.config.js`

**Files:**
- Modify: `vite.config.js`

- [ ] **Step 1: Replace the entire file**

```js
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/curvilinear-mesh-layer/',
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext',
  },
});
```

The COOP/COEP headers are kept because deck.gl/luma.gl may use `SharedArrayBuffer` internally, and `index.html` already loads `coi-serviceworker.js` which expects these headers.

---

## Task 5: Verify in the browser

**Files:** none modified

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Expected:

```
  VITE v6.x.x  ready in NNN ms

  ➜  Local:   http://localhost:5173/curvilinear-mesh-layer/
```

No WASM-related warnings in the console.

- [ ] **Step 2: Open the app and load data**

Open `http://localhost:5173/curvilinear-mesh-layer/` in a browser.

- Select variable: **Sea Surface Height (zeta)**
- Time index: **27000**
- Click **Load**

Expected sequence of status messages:
1. `Opening icechunk store…`
2. `Loading grid coordinates (lon_rho, lat_rho)…`
3. `Loading colormap (bwr)…`
4. `Loading zeta[27000]…`
5. `Tessellating triangles…`
6. Status clears; colorbar appears; performance line shows e.g. `300,560 cells / 601,120 triangles | fetch NNNms | tessellate NNNms`

The map should show colored curvilinear grid cells over the US East Coast.

- [ ] **Step 3: Test a second variable to confirm zarr path resolution works**

Select **Surface Temp (temp)**, time index **27000**, click **Load**.

Expected: data loads, colorbar updates to turbo colormap, no console errors.

- [ ] **Step 4: Stop the dev server** (`Ctrl+C`)

---

## Task 6: Delete dead files

**Files:** delete only

- [ ] **Step 1: Delete the custom storage adapter**

```bash
rm src/icechunk_v2_fetch_storage.js
```

- [ ] **Step 2: Delete the debug inspection scripts**

```bash
rm inspect_manifest.mjs inspect_manifest2.mjs inspect_manifest3.mjs inspect_manifest4.mjs inspect_manifest5.mjs
```

- [ ] **Step 3: Delete the WASM patches and stubs**

```bash
rm -rf patches/ stubs/
```

- [ ] **Step 4: Confirm build still works after deletions**

```bash
npm run build
```

Expected: `dist/` produced with no errors. No missing-import errors (the deleted adapter is no longer referenced by `main.js` after Task 3).

---

## Task 7: Simplify the CI workflow

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Replace the entire file**

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    outputs:
      page_url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - id: deploy
        uses: actions/deploy-pages@v4

  smoke:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - name: Smoke test deployed GitHub Pages app
        run: npm run smoke:pages -- "${{ needs.deploy.outputs.page_url }}"
```

The only change from before: the `Install icechunk WASM package` step (the `curl` + `tar` block) is gone.

---

## Task 8: Final checks and commit

**Files:** none modified

- [ ] **Step 1: Run tests one final time**

```bash
npm test
```

Expected: all green.

- [ ] **Step 2: Confirm build is clean**

```bash
npm run build 2>&1 | tail -10
```

Expected: ends with something like:
```
✓ built in Xs
```
No errors, no WASM warnings.

- [ ] **Step 3: Commit everything**

```bash
git add package.json package-lock.json src/main.js vite.config.js .github/workflows/deploy.yml
git rm src/icechunk_v2_fetch_storage.js inspect_manifest.mjs inspect_manifest2.mjs inspect_manifest3.mjs inspect_manifest4.mjs inspect_manifest5.mjs
git rm -r patches/ stubs/
git commit -m "$(cat <<'EOF'
Migrate from @earthmover/icechunk (WASM) to icechunk-js (pure TypeScript)

IcechunkStore.open(url, { branch: 'main' }) replaces the hand-rolled
createIcechunkV2FetchStorage adapter. icechunk-js auto-detects the v2
format written by Python icechunk 2.0.4 and translates s3:// virtual
chunk references to HTTPS internally. Removes all WASM build plumbing,
CI curl workaround, and debug scripts.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify git status is clean**

```bash
git status
```

Expected: `nothing to commit, working tree clean`
</content>
