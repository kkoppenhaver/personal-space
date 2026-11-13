// The game's look (roadmap Phase 1b).
//
// A look is plain data: how the lights are set and what happens to the
// finished frame. Two modules read it:
//   Rig.js   lights and the sun's shadow map
//   Post.js  the frame: contact shading, bloom, tone mapping, colour, vignette
//
// `sunlit` is the art direction picked in 1b step 1 and the look of the
// game and every bench. `now` is the game as it shipped before 1b, kept for
// one more PR as the A/B baseline on the look lab (`?lookLab=1`).
//
// Surfaces need no look of their own: sunlit shades with plain cosine
// falloff, which is what the game's flat-shaded Lambert materials already do.

import * as THREE from 'three';

export const LOOKS = {
  now: {
    id: 'now',
    name: 'Before 1b',
    blurb: 'The game before 1b: smooth shading, no shadows, no finishing pass.',
    background: 0x05060a,
    lights: {
      sun: { color: 0xfff2d6, intensity: 3.4 },
      fill: { color: 0x9fb4ff, intensity: 1.35 },
      hemi: { sky: 0xc4dcff, ground: 0x4a3d2c, intensity: 0.9 },
      ambient: { color: 0xffffff, intensity: 0.12 },
    },
    shadow: null,
    post: null,       // null = draw straight to the screen, no tone mapping
  },

  sunlit: {
    id: 'sunlit',
    name: 'Sunlit low-poly',
    blurb: 'Crisp facets in clear daylight: soft-edged shadows, cool blue shade, contact shading, filmic colour, glow on the brightest parts.',
    background: 0x060912,
    // The daylit sky, haze and atmosphere are drawn at this fraction of the
    // planet's sky colour. Filmic tone mapping lifts mid tones, so at full
    // strength the sky came out pale grey and the whole day side read as
    // bright.
    skyGain: 0.65,
    lights: {
      sun: { color: 0xfff3dc, intensity: 3.4 },
      fill: null,
      // A strong, blue sky fill: shade is a cool mid tone, not near-black,
      // and reads as shade by its colour as much as its darkness.
      hemi: { sky: 0x9cbcff, ground: 0x8f7a62, intensity: 1.75 },
      ambient: { color: 0xffffff, intensity: 0.14 },
    },
    // Soft-edged, and not fully dark: a little of the sun still reaches
    // shadowed ground, standing in for light bounced off everything nearby.
    // `radius` is in texels of a 2048 map; `bias` is in depth-buffer units
    // of the bench's shadow box (Rig.js converts both for other boxes).
    shadow: { radius: 3.0, intensity: 0.94, bias: -0.0005, normalBias: 0.18 },
    post: {
      toneMapping: THREE.ACESFilmicToneMapping,
      exposure: 0.8,
      ao: { radius: 3.0, intensity: 0.8 },
      // Only light sources and glints glow. Pale ground facing the sun
      // reaches about 1.7 in the HDR buffer, and must not: a threshold of 1
      // put a haze over every bright surface and the paper plane.
      bloom: { strength: 0.22, radius: 0.55, threshold: 2.0 },
      saturation: 1.1,
      contrast: 1.0,
      vignette: 0.14,
    },
  },
};

export const LOOK_ORDER = ['sunlit', 'now'];

/** The look the game renders. */
export const GAME_LOOK = LOOKS.sunlit;

export function getLook(id) {
  return LOOKS[id] || GAME_LOOK;
}
