import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  linearToOklab, oklabToLinear, hexToLinear, meanOklab, gradeColors, oklabToLch,
} from '../../src/world/ColorGrade.js';
import { gradeCentre, resolveColor, GRADE } from '../../src/world/ColorSystem.js';
import { prepareAuthoredColor } from '../../src/world/AuthoredColor.js';
import { applyMaterialSet, buildMaterialSet, familyFromName } from '../../src/world/MaterialSet.js';

const close = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
const flat = (...hexes) => new Float32Array(hexes.flatMap((h) => hexToLinear(h)));
const BROWN = 0x6b4a2b;   // trunk
const GREEN = 0x4f9a3a;   // leaves

describe('OKLab conversion', () => {
  it('round-trips linear RGB', () => {
    for (const rgb of [[0, 0, 0], [1, 1, 1], [0.2, 0.5, 0.1], [0.9, 0.05, 0.3]]) {
      const back = oklabToLinear(...linearToOklab(...rgb));
      rgb.forEach((v, i) => expect(close(back[i], v, 1e-5), `${rgb}`).toBe(true));
    }
  });

  it('puts white at L=1 with no chroma, and orders lightness', () => {
    const w = linearToOklab(1, 1, 1);
    expect(close(w[0], 1, 1e-3) && close(w[1], 0, 1e-3) && close(w[2], 0, 1e-3)).toBe(true);
    expect(linearToOklab(...hexToLinear(GREEN))[0]).toBeGreaterThan(linearToOklab(...hexToLinear(BROWN))[0]);
  });
});

describe('meanOklab', () => {
  it('weights by area', () => {
    const colors = flat(BROWN, GREEN);
    const even = meanOklab(colors);
    const mostlyGreen = meanOklab(colors, [1, 9]);
    const green = linearToOklab(...hexToLinear(GREEN));
    const dist = (m) => Math.hypot(m[0] - green[0], m[1] - green[1], m[2] - green[2]);
    expect(dist(mostlyGreen)).toBeLessThan(dist(even));
  });

  it('is safe on empty input', () => {
    expect(meanOklab(new Float32Array(0))).toEqual([0.6, 0, 0]);
  });
});

describe('gradeColors', () => {
  const colors = flat(BROWN, GREEN, GREEN, BROWN);
  const mean = meanOklab(colors);

  it('is the identity when the centre is the mean', () => {
    const out = gradeColors(colors, { mean, centre: mean });
    colors.forEach((v, i) => expect(close(out[i], v, 1e-4)).toBe(true));
  });

  it('moves the asset mean onto the centre and keeps part differences', () => {
    const centre = linearToOklab(...hexToLinear(0x3aa0c9));   // an ocean blue
    const out = gradeColors(colors, { mean, centre });
    const newMean = meanOklab(out);
    centre.forEach((v, i) => expect(close(newMean[i], v, 0.02)).toBe(true));
    // trunk is still darker than leaves, by about the authored amount
    const trunk = linearToOklab(out[0], out[1], out[2]);
    const leaf = linearToOklab(out[3], out[4], out[5]);
    const authoredGap = linearToOklab(...hexToLinear(GREEN))[0] - linearToOklab(...hexToLinear(BROWN))[0];
    expect(leaf[0]).toBeGreaterThan(trunk[0]);
    expect(close(leaf[0] - trunk[0], authoredGap, 0.03)).toBe(true);
    // and they are still different colours, not one flat blue
    expect(Math.hypot(leaf[1] - trunk[1], leaf[2] - trunk[2])).toBeGreaterThan(0.03);
  });

  it('collapses to a flat colour at contrast 0', () => {
    const centre = linearToOklab(...hexToLinear(0x888888));
    const out = gradeColors(colors, { mean, centre, contrast: 0 });
    for (let i = 3; i < out.length; i++) expect(close(out[i], out[i % 3], 1e-6)).toBe(true);
  });

  it('never leaves the 0..1 range', () => {
    const centre = linearToOklab(1, 1, 1);
    const out = gradeColors(flat(0x000000, 0xffffff, 0xff0000), { mean: [0.5, 0, 0], centre, contrast: 2 });
    for (const v of out) expect(v >= 0 && v <= 1).toBe(true);
  });
});

describe('gradeCentre', () => {
  const greenMean = linearToOklab(...hexToLinear(GREEN));
  const greyMean = linearToOklab(...hexToLinear(0x8a8a8a));
  const ICE = 0xb8d8e8;

  it('pulls a coloured asset toward the accent hue without greying it out', () => {
    const c = oklabToLch(gradeCentre({ family: 'flora', biome: 'ice', biomeAccentHex: ICE, assetId: 'a', mean: greenMean }));
    const from = oklabToLch(greenMean);
    const hueGap = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
    expect(hueGap(c.h, 230)).toBeLessThan(hueGap(from.h, 230));   // closer to ice blue
    expect(c.c).toBeGreaterThan(0.02);                             // still a colour
  });

  it('tints a grey asset toward the accent instead of spinning a meaningless hue', () => {
    const c = oklabToLch(gradeCentre({ family: 'rock', biome: 'ice', biomeAccentHex: ICE, assetId: 'a', mean: greyMean }));
    const accent = oklabToLch(linearToOklab(...hexToLinear(ICE)));
    expect(c.c).toBeGreaterThan(0);
    expect(Math.abs(((c.h - accent.h + 540) % 360) - 180)).toBeLessThan(25);
  });

  it('keeps animals close to their own colour (low creature blend)', () => {
    const fox = linearToOklab(...hexToLinear(0xc8752e));
    const c = gradeCentre({ family: 'creature', biome: 'ice', biomeAccentHex: ICE, assetId: 'fox', mean: fox });
    expect(Math.hypot(c[0] - fox[0], c[1] - fox[1], c[2] - fox[2])).toBeLessThan(0.06);
  });

  it('strength 0 leaves the mean where it was (up to per-asset jitter)', () => {
    const saved = GRADE.strength;
    GRADE.strength = 0;
    try {
      const c = gradeCentre({ family: 'structure', biome: 'forest', biomeAccentHex: 0x4a7c3a, assetId: 'x', mean: greenMean });
      expect(Math.hypot(c[0] - greenMean[0], c[1] - greenMean[1], c[2] - greenMean[2])).toBeLessThan(0.01);
    } finally { GRADE.strength = saved; }
  });
});

// A two-part "tree": trunk and canopy as separate meshes with their own
// material colours — the shape of a multi-material GLB before any bake.
function makeTree({ trunk = BROWN, canopy = GREEN, baked = false } = {}) {
  const root = new THREE.Group();
  const part = (hex, name, w, h) => {
    const g = new THREE.BoxGeometry(w, h, w);
    const m = new THREE.MeshStandardMaterial({ name });
    if (baked) {
      const [r, gg, b] = hexToLinear(hex);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([r, gg, b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    } else {
      m.color.setHex(hex);   // sRGB hex → linear working colour
    }
    return new THREE.Mesh(g, m);
  };
  root.add(part(trunk, 'Tree_Bark', 1, 4), part(canopy, 'Tree_Leaves', 4, 4));
  return root;
}

describe('prepareAuthoredColor', () => {
  it('reads material colours when there is no COLOR_0', () => {
    const tree = makeTree();
    const info = prepareAuthoredColor(tree);
    expect(info.authored).toBe(true);
    expect(tree.children[0].geometry.userData.authoredColors).toBeInstanceOf(Float32Array);
    // the canopy is far bigger, so the mean sits nearer the green
    const green = linearToOklab(...hexToLinear(GREEN));
    const brown = linearToOklab(...hexToLinear(BROWN));
    const d = (p) => Math.hypot(info.mean[0] - p[0], info.mean[1] - p[1], info.mean[2] - p[2]);
    expect(d(green)).toBeLessThan(d(brown));
  });

  it('reads baked COLOR_0', () => {
    const info = prepareAuthoredColor(makeTree({ baked: true }));
    expect(info.authored).toBe(true);
  });

  it('treats exporter default grey as "no colour"', () => {
    const root = new THREE.Group();
    const m = new THREE.MeshStandardMaterial();
    m.color.setRGB(0.64, 0.64, 0.64);   // linear, as GLTFLoader delivers it
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m));
    const info = prepareAuthoredColor(root);
    expect(info.authored).toBe(false);
    expect(root.children[0].geometry.userData.authoredColors).toBeNull();
  });

  it('treats a white, untextured material as "no colour" (its colour lived in a texture)', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ name: 'colormap' })));
    expect(prepareAuthoredColor(root).authored).toBe(false);
  });

  it('is idempotent', () => {
    const tree = makeTree();
    expect(prepareAuthoredColor(tree)).toBe(prepareAuthoredColor(tree));
  });
});

describe('applyMaterialSet', () => {
  const palette = { water: '#21507e', low: '#5b8a3a', mid: '#a98a4b', high: '#7a5a3c', snow: '#b8d8e8', sky: '#9ac4e8' };

  function mount(source, meta = { family: 'flora', assetId: 'test:tree' }) {
    const info = prepareAuthoredColor(source);
    const clone = source.clone(true);
    clone.userData.authoredColor = info;
    applyMaterialSet(clone, buildMaterialSet(palette, { biome: 'ice' }), meta);
    return clone;
  }
  const firstColor = (mesh) => linearToOklab(...Array.from(mesh.geometry.attributes.color.array.slice(0, 3)));

  it('gives every mesh a vertex-coloured material and its own geometry', () => {
    const source = makeTree();
    const clone = mount(source);
    clone.children.forEach((mesh, i) => {
      expect(mesh.material.vertexColors).toBe(true);
      expect(mesh.material.userData.cloned).toBe(true);
      expect(mesh.material.userData.vertexColored).toBe(true);
      expect(mesh.geometry).not.toBe(source.children[i].geometry);
      expect(mesh.geometry.attributes.color.count).toBe(mesh.geometry.attributes.position.count);
    });
    // the cached source is untouched
    expect(source.children[0].geometry.attributes.color).toBeUndefined();
    expect(source.children[0].material.vertexColors).toBe(false);
  });

  it('keeps the trunk darker and differently coloured than the canopy', () => {
    const clone = mount(makeTree());
    const trunk = firstColor(clone.children[0]);
    const canopy = firstColor(clone.children[1]);
    expect(canopy[0] - trunk[0]).toBeGreaterThan(0.08);
    expect(Math.hypot(canopy[1] - trunk[1], canopy[2] - trunk[2])).toBeGreaterThan(0.03);
  });

  it('the same asset lands on different colours on different planets', () => {
    const source = makeTree();
    const info = prepareAuthoredColor(source);
    const on = (biome, snow) => {
      const c = source.clone(true);
      c.userData.authoredColor = info;
      applyMaterialSet(c, buildMaterialSet({ ...palette, snow }, { biome }), { family: 'flora', assetId: 't' });
      return firstColor(c.children[1]);
    };
    const ice = on('ice', '#b8d8e8');
    const volcanic = on('volcanic', '#b84a2a');
    expect(Math.hypot(ice[1] - volcanic[1], ice[2] - volcanic[2])).toBeGreaterThan(0.04);
  });

  it('falls back to part families by material name when nothing was authored', () => {
    const source = makeTree();
    for (const mesh of source.children) mesh.material.color.setRGB(0.64, 0.64, 0.64);
    const clone = mount(source);
    const trunk = firstColor(clone.children[0]);    // "Tree_Bark"   → wood
    const canopy = firstColor(clone.children[1]);   // "Tree_Leaves" → flora
    expect(Math.hypot(trunk[0] - canopy[0], trunk[1] - canopy[1], trunk[2] - canopy[2])).toBeGreaterThan(0.05);
    // and matches the flat family colour exactly
    const wood = linearToOklab(...hexToLinear(resolveColor({ family: 'wood', biome: 'ice', biomeAccentHex: 0xb8d8e8, assetId: 'test:tree' })));
    trunk.forEach((v, i) => expect(close(v, wood[i], 1e-3)).toBe(true));
  });

  it('leaves a hero-tagged mesh alone', () => {
    const source = makeTree();
    source.children[0].userData.matSlot = 'hero';
    const clone = mount(source);
    expect(clone.children[0].material.vertexColors).toBe(false);
    expect(clone.children[1].material.vertexColors).toBe(true);
  });
});

describe('familyFromName', () => {
  it('finds a part family anywhere in a material name', () => {
    expect(familyFromName('BirchTree_Bark')).toBe('wood');
    expect(familyFromName('Pine_Leaves')).toBe('flora');
    expect(familyFromName('Rocks')).toBe('rock');
    expect(familyFromName('Atlas')).toBeNull();
    expect(familyFromName(undefined)).toBeNull();
  });
});
