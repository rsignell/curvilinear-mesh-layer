/**
 * COAWST Curvilinear Grid Viewer
 *
 * Opens the COAWST icechunk store from AWS Open Data via icechunk.js,
 * tessellates the 2D curvilinear ROMS grid with curvilinear_mesh_layer.js,
 * and renders with deck.gl over a MapLibre basemap.
 *
 * Data: s3://usgs-coawst/useast-archive/icechunk/coawst-useast.icechunk
 * Grid: 336 × 896 (eta_rho × xi_rho), ~300K curvilinear quad cells
 */

import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { Repository } from '@earthmover/icechunk';
import { createFetchStorage } from '@earthmover/icechunk/fetch-storage';
import { root as zarrRoot, open as zarrOpen, get as zarrGet, slice } from 'zarrita';
import { loadColorLUT, tessellate, buildLayer, dataRange } from '../curvilinear_mesh_layer.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const ROWS = 336, COLS = 896;

// Public S3 URL for the icechunk store (AWS Open Data Program)
const ICECHUNK_URL =
  'https://usgs-coawst.s3.us-west-2.amazonaws.com' +
  '/useast-archive/icechunk/coawst-useast.icechunk';

const COLORMAP_BASE =
  'https://cdn.jsdelivr.net/gh/kylebarron/deck.gl-raster/assets/colormaps/';

const VAR_META = {
  zeta:  { label: 'Sea Surface Height (m)', is3d: false, cmap: 'bwr'     },
  Hwave: { label: 'Wave Height (m)',         is3d: false, cmap: 'viridis' },
  temp:  { label: 'Surface Temp (°C)',       is3d: true,  cmap: 'turbo'   },
  salt:  { label: 'Surface Salinity (PSU)',  is3d: true,  cmap: 'viridis' },
};

// ── App state ─────────────────────────────────────────────────────────────────
let zarrStore = null;   // icechunk zarr store (opened once)
let lon = null;         // Float32Array grid coordinates (cached)
let lat = null;
let deckOverlay = null;

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.style.display = msg ? 'block' : 'none';
}

function renderColorbar(lut, vmin, vmax, label) {
  const canvas = document.getElementById('colorbar-canvas');
  const ctx = canvas.getContext('2d');
  for (let x = 0; x < 256; x++) {
    ctx.fillStyle = `rgb(${lut[x*4]},${lut[x*4+1]},${lut[x*4+2]})`;
    ctx.fillRect(x, 0, 1, 14);
  }
  document.getElementById('cb-min').textContent   = vmin.toFixed(2);
  document.getElementById('cb-max').textContent   = vmax.toFixed(2);
  document.getElementById('colorbar-title').textContent = label;
  document.getElementById('colorbar').style.display     = 'block';
}

// ── MapLibre ──────────────────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
  center: [-74, 35],
  zoom: 4,
});

map.on('load', () => {
  deckOverlay = new MapboxOverlay({ layers: [] });
  map.addControl(deckOverlay);
});

// ── Open icechunk store ────────────────────────────────────────────────────────
async function openIcechunkStore() {
  setStatus('Opening icechunk store…');

  const storage = createFetchStorage(ICECHUNK_URL);

  // authorizeVirtualChunkAccess: allows icechunk.js to resolve virtual chunk
  // references (which point to the source NetCDF files at the same S3 bucket).
  // Pass null for anonymous/public access.
  // NOTE: Virtual chunk support in the WASM build requires icechunk.js ≥ 2.1.
  // If this fails with a "virtual chunks not supported" error, see README for
  // the binary-file fallback in coawst_viewer.html.
  const repo = await Repository.open(storage, undefined, {
    'https://usgs-coawst.s3.us-west-2.amazonaws.com/': null,
  });

  const session = await repo.readonlySession({ branch: 'main' });
  return session.store;
}

// ── Read a zarr array from the store ──────────────────────────────────────────
async function readArray(path, selection = null) {
  const r = zarrRoot(zarrStore);
  const arr = await zarrOpen(r.resolve(path), { kind: 'array' });
  const result = selection ? await zarrGet(arr, selection) : await zarrGet(arr);
  // zarrita returns { data: TypedArray, shape, stride, offset }
  return new Float32Array(result.data.buffer ?? result.data);
}

// ── Load grid coordinates (cached) ───────────────────────────────────────────
async function loadGrid() {
  if (lon) return;
  setStatus('Loading grid coordinates (lon_rho, lat_rho)…');
  [lon, lat] = await Promise.all([
    readArray('lon_rho'),
    readArray('lat_rho'),
  ]);
  console.log(`Grid: ${ROWS}×${COLS}, lon [${lon[0].toFixed(2)}, ${lon[lon.length-1].toFixed(2)}]`);
}

// ── Load & render ─────────────────────────────────────────────────────────────
async function loadAndRender() {
  const varName  = document.getElementById('varSelect').value;
  const timeIdx  = parseInt(document.getElementById('timeInput').value);
  const cmapName = document.getElementById('cmapSelect').value;
  const opacity  = parseInt(document.getElementById('opacitySlider').value);
  const meta     = VAR_META[varName];
  const btn      = document.getElementById('loadBtn');

  btn.disabled = true;
  document.getElementById('perf').textContent = '';

  try {
    // Open store on first call
    if (!zarrStore) {
      zarrStore = await openIcechunkStore();
    }

    // Load grid once
    await loadGrid();

    // Load colormap LUT
    setStatus(`Loading colormap (${cmapName})…`);
    const lut = await loadColorLUT(`${COLORMAP_BASE}${cmapName}.png`);

    // Load one time slice of the chosen variable
    setStatus(`Loading ${varName}[${timeIdx}]…`);
    const t0 = performance.now();

    let data;
    if (meta.is3d) {
      // 3D variable (ocean_time, s_rho, eta_rho, xi_rho) — select surface level (s_rho=-1)
      // zarrita slice: [timeIdx, lastSrho, :, :]
      // We don't know s_rho length without a separate read; use -1 via zarrita slice
      const r = zarrRoot(zarrStore);
      const arr = await zarrOpen(r.resolve(varName), { kind: 'array' });
      const nSrho = arr.shape[1];
      const result = await zarrGet(arr, [timeIdx, nSrho - 1, slice(null), slice(null)]);
      data = new Float32Array(result.data.buffer ?? result.data);
    } else {
      // 2D variable (ocean_time, eta_rho, xi_rho)
      const r = zarrRoot(zarrStore);
      const arr = await zarrOpen(r.resolve(varName), { kind: 'array' });
      const result = await zarrGet(arr, [timeIdx, slice(null), slice(null)]);
      data = new Float32Array(result.data.buffer ?? result.data);
    }

    const fetchMs = (performance.now() - t0).toFixed(0);

    // Tessellate
    setStatus('Tessellating…');
    const t1 = performance.now();
    const [vmin, vmax] = dataRange(data);
    const tess = tessellate(lon, lat, data, ROWS, COLS, lut, vmin, vmax);
    const tessMs = (performance.now() - t1).toFixed(0);

    // Apply opacity from slider
    for (let i = 3; i < tess.fillColors.length; i += 4) {
      if (tess.fillColors[i] > 0) tess.fillColors[i] = opacity;
    }

    // Build deck.gl layer and update overlay
    const layer = buildLayer(tess, `curvilinear-${varName}-${timeIdx}`);
    deckOverlay.setProps({ layers: [layer] });

    renderColorbar(lut, vmin, vmax, meta.label);
    setStatus('');

    const nCells = tess.nCells.toLocaleString();
    document.getElementById('perf').textContent =
      `${nCells} quads | fetch ${fetchMs}ms | tessellate ${tessMs}ms`;

  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────
document.getElementById('loadBtn').addEventListener('click', loadAndRender);

// Sync colormap suggestion when variable changes
document.getElementById('varSelect').addEventListener('change', () => {
  const meta = VAR_META[document.getElementById('varSelect').value];
  document.getElementById('cmapSelect').value = meta.cmap;
});

// Re-render on opacity slider release
document.getElementById('opacitySlider').addEventListener('change', () => {
  if (deckOverlay && lon) loadAndRender();
});
