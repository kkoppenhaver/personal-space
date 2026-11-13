// Art-direction presets ("looks") — roadmap Phase 1b.
//
// A look is plain data: how the lights are set, how a surface turns light
// into colour (the ramp), and what happens to the finished frame (post).
// Three modules read it:
//   Rig.js           lights and the sun's shadow map
//   LookMaterial.js  surface shading (ramp, rim light, card grain)
//   Post.js          the frame: tone mapping, bloom, outline, grain, …
//
// `now` is the game as it shipped before 1b, kept as the baseline.
// The other three are candidates; `?lookLab=1` shows them side by side.
// Once one is chosen it becomes the game's look and the rest can go.

import * as THREE from 'three';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const LOOKS = {
  now: {
    id: 'now',
    name: 'Now',
    blurb: 'The game today: smooth shading, no shadows, no finishing pass.',
    background: 0x05060a,
    lights: {
      sun: { color: 0xfff2d6, intensity: 3.4 },
      fill: { color: 0x9fb4ff, intensity: 1.35 },
      hemi: { sky: 0xc4dcff, ground: 0x4a3d2c, intensity: 0.9 },
      ambient: { color: 0xffffff, intensity: 0.12 },
    },
    shadow: null,
    ramp: null,       // null = leave the game's own materials alone
    surface: null,
    post: null,       // null = draw straight to the screen
  },

  paper: {
    id: 'paper',
    name: 'Paper diorama',
    blurb: 'A miniature made of card: two soft tones, cool shade, warm edges, paper grain.',
    background: 0x17182e,
    lights: {
      sun: { color: 0xfff0d6, intensity: 2.4 },
      fill: null,
      hemi: { sky: 0xcdd3ff, ground: 0xf0cfae, intensity: 1.35 },
      ambient: { color: 0xffffff, intensity: 0.0 },
    },
    shadow: { radius: 2.2, intensity: 1.0, bias: -0.0005, normalBias: 0.22 },
    // Two tones with a soft edge: everything the sun reaches sits in one
    // nearly flat lit tone, everything else in the shade tone the sky gives.
    ramp: (ndl) => smoothstep(0.02, 0.2, ndl) * (0.76 + 0.24 * Math.max(0, ndl)),
    surface: {
      rim: { color: 0xffd7a6, strength: 0.34, power: 2.6 },
      grain: 0.075,   // fibre noise that sticks to the surface
      facet: 0.06,    // each flat face is its own piece of card
    },
    post: {
      toneMapping: THREE.NeutralToneMapping,
      exposure: 0.92,
      ao: { radius: 4.0, intensity: 0.6 },
      bloom: null,      // card does not glow
      outline: null,
      tiltShift: 1.0,   // used by "photo" framing only
      saturation: 0.97,
      contrast: 0.98,
      lift: { color: 0x241b2b, amount: 0.22 },
      hatch: 0,
      grain: 0.05,
      vignette: 0.24,
    },
  },

  sunlit: {
    id: 'sunlit',
    name: 'Sunlit low-poly',
    blurb: 'Crisp facets in clear daylight: soft-edged shadows, cool blue shade, contact shading, filmic colour, glow on the brightest parts.',
    background: 0x060912,
    lights: {
      sun: { color: 0xfff3dc, intensity: 3.9 },
      fill: null,
      // A strong, blue sky fill: shade is a cool mid tone, not near-black,
      // and reads as shade by its colour as much as its darkness.
      hemi: { sky: 0x9cbcff, ground: 0x8f7a62, intensity: 1.45 },
      ambient: { color: 0xffffff, intensity: 0.12 },
    },
    // Soft-edged, and not fully dark: a little of the sun still reaches
    // shadowed ground, standing in for light bounced off everything nearby.
    shadow: { radius: 3.0, intensity: 0.94, bias: -0.0005, normalBias: 0.18 },
    // Plain cosine falloff: every facet a slightly different tone.
    ramp: (ndl) => Math.max(0, ndl),
    surface: {
      rim: { color: 0xffffff, strength: 0.0, power: 3.0 },
      grain: 0.0,
      facet: 0.0,
    },
    post: {
      toneMapping: THREE.ACESFilmicToneMapping,
      exposure: 1.02,
      ao: { radius: 3.0, intensity: 0.8 },
      bloom: { strength: 0.22, radius: 0.55, threshold: 1.0 },
      outline: null,
      tiltShift: 0,
      saturation: 1.1,
      contrast: 1.0,
      lift: null,
      hatch: 0,
      grain: 0.0,
      vignette: 0.14,
    },
  },

  ink: {
    id: 'ink',
    name: 'Inked storybook',
    blurb: 'A picture-book page: flat colour in three steps, drawn outlines, hatched shade.',
    background: 0x1c2140,
    lights: {
      sun: { color: 0xffffff, intensity: 2.0 },
      fill: null,
      hemi: { sky: 0xdfe5ff, ground: 0xe6d6c2, intensity: 1.7 },
      ambient: { color: 0xffffff, intensity: 0.0 },
    },
    shadow: { radius: 0.9, intensity: 1.0, bias: -0.0005, normalBias: 0.18 },
    // Three hard steps.
    ramp: (ndl) => 0.55 * smoothstep(-0.01, 0.01, ndl) + 0.45 * smoothstep(0.54, 0.56, ndl),
    surface: {
      rim: { color: 0xffffff, strength: 0.0, power: 3.0 },
      grain: 0.03,
      facet: 0.0,
    },
    post: {
      toneMapping: THREE.NoToneMapping,
      exposure: 1.0,
      ao: null,
      bloom: null,
      outline: { color: 0x241a17, thickness: 1.1, depth: 0.012, normal: 0.75, wobble: 0.6, fullAt: 60 },
      tiltShift: 0,
      saturation: 0.9,
      contrast: 1.0,
      lift: { color: 0x2b2233, amount: 0.2 },
      hatch: 0.55,
      grain: 0.085,
      vignette: 0.18,
    },
  },
};

export const LOOK_ORDER = ['now', 'paper', 'sunlit', 'ink'];

export function getLook(id) {
  return LOOKS[id] || LOOKS.now;
}

/**
 * How much of the sun's light a surface takes, by the angle between its
 * normal and the sun (`ndl` = cosine, −1…1). 0 = shade tone only.
 */
export function rampValue(look, ndl) {
  if (!look?.ramp) return Math.max(0, ndl);
  return Math.min(1, Math.max(0, look.ramp(ndl)));
}

const RAMP_SIZE = 256;
const _rampTextures = new Map();

/**
 * The look's ramp as a 256×1 texture for MeshToonMaterial.gradientMap,
 * which samples it at u = ndl·0.5 + 0.5.
 */
export function rampTexture(look) {
  let tex = _rampTextures.get(look.id);
  if (tex) return tex;
  const data = new Uint8Array(RAMP_SIZE);
  for (let i = 0; i < RAMP_SIZE; i++) {
    const ndl = ((i + 0.5) / RAMP_SIZE) * 2 - 1;
    data[i] = Math.round(rampValue(look, ndl) * 255);
  }
  tex = new THREE.DataTexture(data, RAMP_SIZE, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  _rampTextures.set(look.id, tex);
  return tex;
}
