# curvilinear-mesh-layer

Browser visualization of 2D curvilinear ocean model grids using
[icechunk.js](https://github.com/earth-mover/icechunk) + [deck.gl](https://deck.gl),
reading directly from the USGS [COAWST US East Coast icechunk store](https://www.sciencebase.gov/catalog/item/5f9c9e2482cef313ed9e06d9)
on AWS Open Data — no server, no pre-exported files.

Inspired by Kyle Barron's [RasterMeshLayer](https://kylebarron.dev/deck.gl-raster/layers/raster-mesh-layer/).

## How it works

ROMS/COAWST uses a **curvilinear sigma-coordinate grid** where longitude and
latitude are 2D arrays (`lon_rho[336, 896]`, `lat_rho[336, 896]`), not 1D
vectors. Standard map tile libraries can't render this directly.

The Vite viewer solves this in three steps:

1. **Read** — `@earthmover/icechunk` opens `s3://usgs-coawst/.../coawst-useast.icechunk`
   via a v2-only fetch storage adapter (HTTP byte-range requests, no AWS credentials)
   and zarrita reads a single time slice of any variable
2. **Tessellate** — center lon/lat coordinates are extrapolated to inferred
   cell corners; each inferred quad is split into two fixed-diagonal triangles
   with per-vertex color values
3. **Render** — ~300K cells / ~600K triangles via a custom deck.gl layer
   (binary attribute mode: pure TypedArrays, no JavaScript objects per cell)

```
icechunk.js + zarrita
  → lon_rho[336,896] + zeta[timeIdx, 336, 896]  (from S3, virtual chunks)
  → inferCornersFromCenters() + tessellateTriangles()
  → deck.gl custom triangle layer with interpolated vertex colors
  → MapLibre GL JS basemap
```

## Quick start

```bash
git clone https://github.com/rsignell/curvilinear-mesh-layer
cd curvilinear-mesh-layer
npm install
npm run dev
# open http://localhost:5173
```

Select a variable, enter a time index (0–112,391 for 2009–2022 hourly data),
and click **Load**.

## Production build

```bash
npm run build     # → dist/
npm run preview   # serve dist/ locally
```

The `dist/` directory is a self-contained static site ready for GitHub Pages,
S3 static hosting, or any CDN.

## Files

| File | Purpose |
|------|---------|
| `curvilinear_mesh_layer.js` | Reusable flat-quad and triangle tessellation helpers |
| `src/curvilinear_triangle_layer.js` | Custom deck.gl triangle layer with interpolated vertex colors |
| `src/main.js` | App logic: icechunk.js → zarrita → deck.gl |
| `index.html` | HTML entry point (Vite) |
| `vite.config.js` | Vite config (WASM plugin for icechunk.js) |
| `COAWST_webgl_demo.ipynb` | Notebook: Python comparison + IFrame embed |
| `coawst_viewer.html` | Standalone demo using pre-exported binary files (no bundler needed) |

## `curvilinear_mesh_layer.js` API

The core module works both as an ES module (via Vite) and as a plain
`<script>` tag (exposes `window.CurvilinearMeshLayer`):

```js
// Load a 256-entry RGBA LUT from a colormap PNG
const lut = await CurvilinearMeshLayer.loadColorLUT(url);

// Legacy flat-quad tessellation — lon, lat, data are flat Float32Arrays (rows × cols)
const tess = CurvilinearMeshLayer.tessellate(
  lon, lat, data, rows, cols, lut, vmin, vmax
);

// Build deck.gl SolidPolygonLayer (binary attribute mode)
const layer = CurvilinearMeshLayer.buildLayer(tess, 'my-layer-id');
deckOverlay.setProps({ layers: [layer] });

// Robust [vmin, vmax] ignoring NaN/fill values
const [vmin, vmax] = CurvilinearMeshLayer.dataRange(data);

// Triangle tessellation for center-coordinate grids
const corners = CurvilinearMeshLayer.inferCornersFromCenters(lon, lat, data, rows, cols);
const triTess = CurvilinearMeshLayer.tessellateTriangles(
  corners.cornerLon, corners.cornerLat, corners.cornerData,
  data, rows, cols, lut, vmin, vmax, 210
);
```

## Note on virtual chunks

The COAWST icechunk store uses **virtual chunks** — references to byte ranges
in the source NetCDF files on S3. The browser demo uses `authorizeVirtualChunkAccess`
to resolve these:

```js
const repo = await Repository.open(storage, undefined, {
  'https://usgs-coawst.s3.us-west-2.amazonaws.com/': null,  // null = anonymous
});
```

Virtual chunk support in the icechunk.js WASM build was added in v2.0.
If you encounter a "virtual chunks not supported" error, open an issue.
The `coawst_viewer.html` file provides a fallback that works with
pre-exported binary files (no WASM required).

## Extending to other models

Any ROMS, SCHISM, or FVCOM output with 2D lon/lat coordinate arrays works.
Replace the icechunk store URL and adjust `ROWS`, `COLS` in `src/main.js`.
The tessellation logic is model-agnostic.
