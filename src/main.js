/**
 * COAWST Curvilinear Grid Viewer
 *
 * Reads Kerchunk JSON reference files from S3, fetches byte ranges from the
 * raw NetCDF files via HTTP range requests, and renders with deck.gl over a
 * MapLibre basemap.  No icechunk dependency required.
 *
 * Data: s3://usgs-coawst/useast-archive/json/ (740 weekly Kerchunk JSON files)
 * Grid: 336 × 896 (eta_rho × xi_rho), ~300K curvilinear center cells
 */

import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { root as zarrRoot, open as zarrOpen, get as zarrGet, slice } from 'zarrita';
import {
  inferCornersFromCenters,
  loadColorLUT,
  tessellateTriangles,
  dataRange,
} from '../curvilinear_mesh_layer.js';
import { buildTriangleLayer } from './curvilinear_triangle_layer.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const ROWS = 336, COLS = 896;
const S3_BASE  = 'https://usgs-coawst.s3.us-west-2.amazonaws.com';
const JSON_PFX = 'useast-archive/json';
const COLORMAP_BASE =
  'https://cdn.jsdelivr.net/gh/kylebarron/deck.gl-raster/assets/colormaps/';

const VAR_META = {
  zeta:  { label: 'Sea Surface Height (m)', is3d: false, cmap: 'bwr'     },
  Hwave: { label: 'Wave Height (m)',         is3d: false, cmap: 'viridis' },
  temp:  { label: 'Surface Temp (°C)',       is3d: true,  cmap: 'turbo'   },
  salt:  { label: 'Surface Salinity (PSU)',  is3d: true,  cmap: 'viridis' },
};

// ── App state ─────────────────────────────────────────────────────────────────
let jsonFileList = null;  // sorted S3 keys for json/*.json, cached after first fetch
let lon = null;           // Float32Array grid coordinates (cached after first load)
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

// ── Kerchunk store ────────────────────────────────────────────────────────────

function s3ToHttps(url) {
  // s3://bucket/key → https://bucket.s3.us-west-2.amazonaws.com/key
  return url.replace(/^s3:\/\/([^/]+)\//, `https://$1.s3.us-west-2.amazonaws.com/`);
}

// Build a zarrita-compatible store from a parsed Kerchunk `refs` dict.
function makeKerchunkStore(refs) {
  async function getBytes(key) {
    const k = key.startsWith('/') ? key.slice(1) : key;
    const ref = refs[k];
    if (ref === undefined) return undefined;

    // Inline string: raw JSON metadata or base64-encoded bytes
    if (typeof ref === 'string') {
      if (ref.startsWith('base64:')) {
        const bin = atob(ref.slice(7));
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf;
      }
      return new TextEncoder().encode(ref);
    }

    // Array reference: [s3_url, byte_offset, byte_length]
    if (Array.isArray(ref)) {
      const [rawUrl, offset, length] = ref;
      const url = s3ToHttps(rawUrl);
      const headers = (offset != null && length != null)
        ? { Range: `bytes=${offset}-${offset + length - 1}` }
        : {};
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
      return new Uint8Array(await resp.arrayBuffer());
    }

    return undefined;
  }

  return {
    get: getBytes,
    // zarrita may call getRange for partial reads; satisfy it by slicing get()
    async getRange(key, offset, length) {
      const data = await getBytes(key);
      return data?.slice(offset, offset + length);
    },
  };
}

// Fetch and cache the sorted list of Kerchunk JSON S3 keys.
async function getFileList() {
  if (jsonFileList) return jsonFileList;
  setStatus('Fetching file list…');
  const listUrl = `${S3_BASE}/?list-type=2&prefix=${JSON_PFX}/&suffix=.json`;
  const resp = await fetch(listUrl);
  if (!resp.ok) throw new Error(`S3 list failed: ${resp.status}`);
  const xml  = await resp.text();
  const keys = [];
  const re   = /<Key>(.*?\.json)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) keys.push(m[1]);
  keys.sort();
  jsonFileList = keys;
  return keys;
}

// Load the Kerchunk JSON for a given file index and return a zarrita store.
async function loadKerchunkStore(fileIdx) {
  const files = await getFileList();
  const key   = files[fileIdx];
  if (!key) throw new Error(`File index ${fileIdx} out of range (0–${files.length - 1})`);
  const label = key.split('/').pop().replace('.json', '');
  setStatus(`Loading ${label} (file ${fileIdx})…`);
  const resp = await fetch(`${S3_BASE}/${key}`);
  if (!resp.ok) throw new Error(`Cannot load ${key}: ${resp.status}`);
  const json = await resp.json();
  return makeKerchunkStore(json.refs);
}

// ── Array reading ─────────────────────────────────────────────────────────────

async function readArray(store, path, selection = null) {
  const r      = zarrRoot(store);
  const arr    = await zarrOpen(r.resolve(path), { kind: 'array' });
  const result = selection ? await zarrGet(arr, selection) : await zarrGet(arr);
  const raw    = result.data;
  // zarr v2 stores lon/lat as f8; convert to f32 for tessellation
  if (raw instanceof Float32Array) return raw;
  return Float32Array.from(raw);
}

// ── Grid loading (cached) ─────────────────────────────────────────────────────

async function loadGrid(store) {
  if (lon) return;
  setStatus('Loading grid coordinates (lon_rho, lat_rho)…');
  [lon, lat] = await Promise.all([
    readArray(store, 'lon_rho'),
    readArray(store, 'lat_rho'),
  ]);
  console.log(`Grid: ${ROWS}×${COLS}, lon [${lon[0].toFixed(2)}, ${lon[lon.length-1].toFixed(2)}]`);
}

// ── Load & render ─────────────────────────────────────────────────────────────
async function loadAndRender() {
  const varName  = document.getElementById('varSelect').value;
  const fileIdx  = parseInt(document.getElementById('timeInput').value);
  const cmapName = document.getElementById('cmapSelect').value;
  const opacity  = parseInt(document.getElementById('opacitySlider').value);
  const meta     = VAR_META[varName];
  const btn      = document.getElementById('loadBtn');

  btn.disabled = true;
  document.getElementById('perf').textContent = '';

  try {
    const store = await loadKerchunkStore(fileIdx);

    // Load grid once (from the first file that gets loaded)
    await loadGrid(store);

    // Load colormap LUT
    setStatus(`Loading colormap (${cmapName})…`);
    const lut = await loadColorLUT(`${COLORMAP_BASE}${cmapName}.png`);

    // Load one time step from the variable (always take local time index 0)
    setStatus(`Loading ${varName} from file ${fileIdx}…`);
    const t0 = performance.now();

    let data;
    if (meta.is3d) {
      // Shape: [n_time, s_rho, eta_rho, xi_rho] — select time=0, surface s_rho level
      const r    = zarrRoot(store);
      const arr  = await zarrOpen(r.resolve(varName), { kind: 'array' });
      const nSrho = arr.shape[1];
      const result = await zarrGet(arr, [0, nSrho - 1, slice(null), slice(null)]);
      const raw = result.data;
      data = raw instanceof Float32Array ? raw : Float32Array.from(raw);
    } else {
      // Shape: [n_time, eta_rho, xi_rho] — select time=0
      data = await readArray(store, varName, [0, slice(null), slice(null)]);
    }

    const fetchMs = (performance.now() - t0).toFixed(0);

    // Infer corners and tessellate
    setStatus('Tessellating triangles…');
    const t1 = performance.now();
    const [vmin, vmax] = dataRange(data);
    const corners = inferCornersFromCenters(lon, lat, data, ROWS, COLS);
    const tess = tessellateTriangles(
      corners.cornerLon, corners.cornerLat, corners.cornerData,
      data, ROWS, COLS, lut, vmin, vmax, opacity,
    );
    const tessMs = (performance.now() - t1).toFixed(0);

    // Render
    const layer = buildTriangleLayer(tess, `curvilinear-${varName}-${fileIdx}`);
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
