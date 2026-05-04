# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dependencies
npm run dev        # dev server at http://localhost:5173
npm run build      # production build → dist/
npm run preview    # serve dist/ locally
```

No test suite or linter is configured.

## Architecture

This is a **Vite + ES module** browser app. Entry point: `index.html` → `src/main.js`.

**Data flow:**
```
icechunk.js (WASM) + zarrita
  → lon_rho[336,896] + variable[timeIdx, 336, 896]  (S3 byte-range requests)
  → tessellate() in curvilinear_mesh_layer.js        (JS, ~300K quads as TypedArrays)
  → deck.gl SolidPolygonLayer (binary attribute mode, GPU render)
  → MapLibre GL JS basemap (OSM tiles)
```

**Key files:**

- `curvilinear_mesh_layer.js` — reusable module with four exported functions: `loadColorLUT`, `tessellate`, `buildLayer`, `dataRange`. Dual-mode: ES import or `window.CurvilinearMeshLayer` via `<script>` tag.
- `src/main.js` — app logic. Opens the icechunk store once, caches `lon`/`lat` grid coordinates across loads, reads zarr arrays per-click, calls the layer module, and updates the deck.gl overlay.
- `coawst_viewer.html` — standalone fallback (no bundler, no WASM) that reads pre-exported binary files instead of the icechunk store.
- `vite.config.js` — WASM support via `vite-plugin-wasm` + `vite-plugin-top-level-await`; `@earthmover/icechunk` is excluded from Vite pre-bundling; COOP/COEP headers for SharedArrayBuffer.

**Tessellation details:**

`tessellate()` in `curvilinear_mesh_layer.js` converts the `(rows-1)×(cols-1)` grid cells into deck.gl binary format. Each quad uses CCW winding (SW→SE→NE→NW). Fill color is derived from the average of the four corner values mapped through the 256-entry RGBA LUT. Cells with NaN or fill values (`|val| > 1e36`) are rendered transparent (land mask).

**icechunk / virtual chunks:**

The COAWST store uses virtual chunks — references to byte ranges in source NetCDF files on S3. `Repository.open()` takes an `authorizeVirtualChunkAccess` map with `null` for anonymous public access. Virtual chunk support requires `@earthmover/icechunk` ≥ 2.1.

## Extending to other grids

To adapt for a different ocean model (ROMS, SCHISM, FVCOM):
1. Change `ICECHUNK_URL`, `ROWS`, `COLS` in `src/main.js`
2. Update `VAR_META` with variable names and whether they are 3D (`is3d: true` selects the last `s_rho` level)
3. `curvilinear_mesh_layer.js` is model-agnostic; no changes needed there
