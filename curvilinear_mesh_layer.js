/**
 * curvilinear_mesh_layer.js
 *
 * Renders 2D curvilinear ocean-model grids (ROMS, FVCOM, etc.) with deck.gl.
 * Inspired by Kyle Barron's RasterMeshLayer (deck.gl-raster):
 *   https://kylebarron.dev/deck.gl-raster/layers/raster-mesh-layer/
 *
 * Usage (with deck.gl global bundle from CDN):
 *
 *   const { positions, startIndices, fillColors, nCells } =
 *     tessellate(lon, lat, data, rows, cols, colorLUT, vmin, vmax);
 *
 *   const layer = buildLayer({ startIndices, positions, fillColors, nCells });
 *   deckOverlay.setProps({ layers: [layer] });
 *
 * The caller is responsible for loading lon/lat/data as flat Float32Arrays
 * (row-major, rows × cols elements) and a colorLUT (Uint8ClampedArray RGBA,
 * 256 entries = 1024 bytes) from a colormap PNG via loadColorLUT().
 */

'use strict';

/**
 * Load a colormap as a 256-entry RGBA lookup table.
 * Uses a 1×256 canvas to sample any 1D colormap PNG.
 *
 * Colormap PNGs from Kyle Barron's CDN:
 *   viridis, turbo, plasma, inferno, magma, cividis, bwr, ...
 *   https://cdn.jsdelivr.net/gh/kylebarron/deck.gl-raster/assets/colormaps/{name}.png
 *
 * @param {string} url  URL to a horizontal gradient colormap PNG
 * @returns {Uint8ClampedArray}  RGBA lookup table, length 1024 (256 × 4)
 */
async function loadColorLUT(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, 256, 1);
  return ctx.getImageData(0, 0, 256, 1).data; // Uint8ClampedArray, length 1024
}

/**
 * Tessellate a 2D curvilinear grid into deck.gl SolidPolygonLayer binary format.
 *
 * Each grid cell becomes a quadrilateral (4-vertex polygon) with a flat color
 * derived from the average of its four corner data values.
 *
 * Grid cell (i, j) uses corners:
 *   a=(i,j)   b=(i,j+1)   c=(i+1,j)   d=(i+1,j+1)
 * Winding: SW → SE → NE → NW  (counter-clockwise, standard GIS convention)
 *
 * @param {Float32Array} lon      Flat longitude array, length rows × cols
 * @param {Float32Array} lat      Flat latitude array,  length rows × cols
 * @param {Float32Array} data     Flat data array,       length rows × cols
 * @param {number}       rows     Number of rows    (eta_rho for ROMS)
 * @param {number}       cols     Number of columns (xi_rho  for ROMS)
 * @param {Uint8ClampedArray} colorLUT  256-entry RGBA lookup table from loadColorLUT()
 * @param {number}       vmin     Data value mapped to colormap index 0
 * @param {number}       vmax     Data value mapped to colormap index 255
 * @returns {{ startIndices, positions, fillColors, nCells }}
 */
function tessellate(lon, lat, data, rows, cols, colorLUT, vmin, vmax) {
  const nCells = (rows - 1) * (cols - 1);
  const startIndices = new Int32Array(nCells + 1);
  // 4 vertices × 2 coordinates per cell
  const positions = new Float32Array(nCells * 8);
  // 4 RGBA bytes per cell (flat color, one value per polygon)
  const fillColors = new Uint8Array(nCells * 4);

  const range = vmax - vmin || 1;
  let p = 0;

  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const cell = i * (cols - 1) + j;
      startIndices[cell] = cell * 4; // 4 verts per polygon

      const a = i * cols + j;
      const b = a + 1;
      const c = (i + 1) * cols + j;
      const d = c + 1;

      // CCW: SW, SE, NE, NW
      positions[p++] = lon[a]; positions[p++] = lat[a];
      positions[p++] = lon[b]; positions[p++] = lat[b];
      positions[p++] = lon[d]; positions[p++] = lat[d];
      positions[p++] = lon[c]; positions[p++] = lat[c];

      const val = (data[a] + data[b] + data[c] + data[d]) * 0.25;
      const base = cell * 4;

      if (!isFinite(val) || Math.abs(val) > 1e36) {
        // NaN or fill value → transparent (land mask)
        fillColors[base + 3] = 0;
      } else {
        const t = Math.max(0, Math.min(1, (val - vmin) / range));
        const lutIdx = Math.round(t * 255) * 4;
        fillColors[base]     = colorLUT[lutIdx];
        fillColors[base + 1] = colorLUT[lutIdx + 1];
        fillColors[base + 2] = colorLUT[lutIdx + 2];
        fillColors[base + 3] = 210;
      }
    }
  }
  startIndices[nCells] = nCells * 4;

  return { startIndices, positions, fillColors, nCells };
}

/**
 * Build a deck.gl SolidPolygonLayer from tessellated curvilinear data.
 * Requires the deck.gl global bundle to be loaded on the page.
 *
 * @param {{ startIndices, positions, fillColors, nCells }} tessellation
 * @param {string} id  Layer ID (use different IDs to force layer replacement)
 * @returns {deck.SolidPolygonLayer}
 */
function buildLayer({ startIndices, positions, fillColors, nCells }, id = 'curvilinear-mesh') {
  return new deck.SolidPolygonLayer({
    id,
    data: {
      length: nCells,
      startIndices,
      attributes: {
        getPolygon:   { value: positions,  size: 2 },
        getFillColor: { value: fillColors, size: 4 },
      },
    },
    _normalize: false, // skip CCW normalization — our quads are already correct
    extruded: false,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 80],
  });
}

/**
 * Compute a robust [vmin, vmax] from a flat data array, ignoring NaN/fill.
 * Uses the 2nd and 98th percentiles to avoid outlier saturation.
 *
 * @param {Float32Array} data
 * @param {number} fillThreshold  Values above this are treated as fill (default 1e36)
 * @returns {[number, number]}
 */
function dataRange(data, fillThreshold = 1e36) {
  const valid = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (isFinite(v) && Math.abs(v) < fillThreshold) valid.push(v);
  }
  if (valid.length === 0) return [0, 1];
  valid.sort((a, b) => a - b);
  const lo = valid[Math.floor(valid.length * 0.02)];
  const hi = valid[Math.floor(valid.length * 0.98)];
  return [lo, hi];
}

export { loadColorLUT, tessellate, buildLayer, dataRange };

// Script-tag usage (no bundler): expose as global
if (typeof window !== 'undefined') {
  window.CurvilinearMeshLayer = { loadColorLUT, tessellate, buildLayer, dataRange };
}
