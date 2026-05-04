import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inferCornersFromCenters,
  tessellateTriangles,
} from '../curvilinear_mesh_layer.js';

test('inferCornersFromCenters averages interior corners and extrapolates edges', () => {
  const rows = 2;
  const cols = 2;
  const lon = new Float32Array([0, 2, 0, 2]);
  const lat = new Float32Array([0, 0, 2, 2]);
  const data = new Float32Array([0, 2, 4, 6]);

  const corners = inferCornersFromCenters(lon, lat, data, rows, cols);

  assert.equal(corners.cornerLon.length, 9);
  assert.equal(corners.cornerLat.length, 9);
  assert.equal(corners.cornerData.length, 9);

  assert.equal(corners.cornerLon[4], 1);
  assert.equal(corners.cornerLat[4], 1);
  assert.equal(corners.cornerData[4], 3);

  assert.equal(corners.cornerLon[0], -1);
  assert.equal(corners.cornerLat[0], -1);
  assert.equal(corners.cornerData[0], -3);
});

test('tessellateTriangles emits fixed SW-SE-NE and SW-NE-NW triangles', () => {
  const colorLUT = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    colorLUT[i * 4] = i;
    colorLUT[i * 4 + 1] = i;
    colorLUT[i * 4 + 2] = i;
    colorLUT[i * 4 + 3] = 255;
  }

  const tess = tessellateTriangles(
    new Float32Array([0, 1, 0, 1]),
    new Float32Array([0, 0, 1, 1]),
    new Float32Array([0, 0.5, 1, 1]),
    new Float32Array([1]),
    1,
    1,
    colorLUT,
    0,
    1,
    200
  );

  assert.equal(tess.cellCount, 1);
  assert.equal(tess.vertexCount, 6);
  assert.deepEqual(Array.from(tess.positions), [
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 0, 0,
    1, 1, 0,
    0, 1, 0,
  ]);
  assert.deepEqual(Array.from(tess.pickingColors), [
    1, 0, 0,
    1, 0, 0,
    1, 0, 0,
    1, 0, 0,
    1, 0, 0,
    1, 0, 0,
  ]);
  assert.deepEqual(Array.from(tess.colors.slice(0, 8)), [
    0, 0, 0, 200,
    128, 128, 128, 200,
  ]);
});

test('tessellateTriangles makes invalid center cells transparent', () => {
  const colorLUT = new Uint8ClampedArray(256 * 4).fill(255);
  const tess = tessellateTriangles(
    new Float32Array([0, 1, 0, 1]),
    new Float32Array([0, 0, 1, 1]),
    new Float32Array([0, 1, 1, 0]),
    new Float32Array([Number.NaN]),
    1,
    1,
    colorLUT,
    0,
    1,
    210
  );

  for (let i = 3; i < tess.colors.length; i += 4) {
    assert.equal(tess.colors[i], 0);
  }
});
