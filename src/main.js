/**
 * COAWST Curvilinear Grid Viewer
 *
 * Opens the COAWST icechunk v2 store via icechunk-js,
 * reads zarr arrays through zarrita, infers curvilinear
 * cell corners, and renders with deck.gl over a MapLibre basemap.
 *
 * Data: s3://usgs-coawst/useast-archive/icechunk/coawst-useast.icechunk
 * Grid: 336 × 896 (eta_rho × xi_rho), ~300K curvilinear center cells
 */

import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { IcechunkStore } from 'icechunk-js';
import { open as zarrOpen, get as zarrGet, root as zarrRoot, slice } from 'zarrita';
import {
  inferCornersFromCenters,
  loadColorLUT,
  tessellateTriangles,
  dataRange,
} from '../curvilinear_mesh_layer.js';
import { buildTriangleLayer } from './curvilinear_triangle_layer.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const ROWS = 336, COLS = 896;

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
let zarrStore = null;   // IcechunkStore instance (opened once, reused across loads)
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

// ── Open icechunk store (cached) ──────────────────────────────────────────────
async function openStore() {
  if (zarrStore) return zarrStore;
  setStatus('Opening icechunk store…');
  zarrStore = await IcechunkStore.open(ICECHUNK_URL, { branch: 'main' });
  return zarrStore;
}

// ── Read a zarr array from the store ──────────────────────────────────────────
async function readArray(path, selection = null) {
  const arr    = await zarrOpen(zarrRoot(zarrStore).resolve(path), { kind: 'array' });
  const result = selection ? await zarrGet(arr, selection) : await zarrGet(arr);
  const raw    = result.data;
  // lon_rho / lat_rho may be float64 in the store; convert to float32
  if (raw instanceof Float32Array) return raw;
  return Float32Array.from(raw);
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
    await openStore();
    await loadGrid();

    setStatus(`Loading colormap (${cmapName})…`);
    const lut = await loadColorLUT(`${COLORMAP_BASE}${cmapName}.png`);

    setStatus(`Loading ${varName}[${timeIdx}]…`);
    const t0 = performance.now();

    let data;
    if (meta.is3d) {
      const arr   = await zarrOpen(zarrRoot(zarrStore).resolve(varName), { kind: 'array' });
      const nSrho = arr.shape[1];
      const result = await zarrGet(arr, [timeIdx, nSrho - 1, slice(null), slice(null)]);
      const raw = result.data;
      data = raw instanceof Float32Array ? raw : Float32Array.from(raw);
    } else {
      data = await readArray(varName, [timeIdx, slice(null), slice(null)]);
    }

    const fetchMs = (performance.now() - t0).toFixed(0);

    setStatus('Tessellating triangles…');
    const t1 = performance.now();
    const [vmin, vmax] = dataRange(data);
    const corners = inferCornersFromCenters(lon, lat, data, ROWS, COLS);
    const tess = tessellateTriangles(
      corners.cornerLon, corners.cornerLat, corners.cornerData,
      data, ROWS, COLS, lut, vmin, vmax, opacity,
    );
    const tessMs = (performance.now() - t1).toFixed(0);

    const layer = buildTriangleLayer(tess, `curvilinear-${varName}-${timeIdx}`);
    deckOverlay.setProps({ layers: [layer] });

    renderColorbar(lut, vmin, vmax, meta.label);
    setStatus('');

    const nCells = tess.cellCount.toLocaleString();
    const nTri   = (tess.cellCount * 2).toLocaleString();
    document.getElementById('perf').textContent =
      `${nCells} cells / ${nTri} triangles | fetch ${fetchMs}ms | tessellate ${tessMs}ms`;

  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────
document.getElementById('loadBtn').addEventListener('click', loadAndRender);

document.getElementById('varSelect').addEventListener('change', () => {
  const meta = VAR_META[document.getElementById('varSelect').value];
  document.getElementById('cmapSelect').value = meta.cmap;
});

document.getElementById('opacitySlider').addEventListener('change', () => {
  if (deckOverlay && lon) loadAndRender();
});
