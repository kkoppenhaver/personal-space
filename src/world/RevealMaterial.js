// Reveal-as-you-fly material patch.
//
// `patchReveal(material)` injects a `uReveal` uniform into a material's
// fragment shader via onBeforeCompile. uReveal drives a screen-space hash
// dither `discard`:
//   uReveal = 0 → every fragment discarded (fully hidden)
//   uReveal = 1 → no discard (fully solid — clean for the thumbnail)
//   0 < uReveal < 1 → stochastic coverage (materializing)
//
// Why a dither-clip and NOT `transparent` + opacity:
//   - The material stays OPAQUE (depthWrite on, single opaque pass), so it
//     dodges transparency depth-sort artifacts that plague clustered
//     low-poly scatter, and it works for InstancedMesh (one shared material
//     → one uReveal covers every instance; per-instance opacity isn't a
//     thing on InstancedMesh).
//   - On completion we snap uReveal to exactly 1 → a 100%-solid final frame,
//     which alpha-hash transparency can't give us (it stays grainy).
//
// All patched materials share ONE compiled program via a constant
// customProgramCacheKey, so cloning the reveal across every mesh on every
// planet doesn't explode the shader-program count (three.js refcounts
// programs by cache key; target < 25 distinct programs game-wide).

/**
 * Patch a material in place to add a uReveal dither-clip. Returns the
 * uniform object ({ value }) so the owner can tween `.value` 0→1.
 *
 * Safe to call once per material. The returned uniform is per-material
 * (so each planet tweens independently) even though the compiled PROGRAM
 * is shared across all of them.
 *
 * @param {import('three').Material} material
 * @param {number} [initial=0] - starting uReveal value
 * @returns {{ value: number }} the uReveal uniform ref
 */
export function patchReveal(material, initial = 0) {
  const uReveal = { value: initial };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = uReveal;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uReveal;
        // Screen-space hash in [0,1). Stable per pixel for a given frame;
        // the dither pattern is fine-grained noise, not a banding wipe.
        float revealHash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }`
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        if (uReveal < 1.0 && revealHash(gl_FragCoord.xy) >= uReveal) discard;`
      );
  };
  // Constant key → one shared program across every reveal-patched material.
  material.customProgramCacheKey = () => 'planetReveal';
  // onBeforeCompile / customProgramCacheKey are compile-time → must recompile.
  material.needsUpdate = true;
  return uReveal;
}
