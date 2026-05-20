import * as THREE from 'three';

// Floating-origin tracker. Three.js and Rapier both use 32-bit floats for
// positions; precision degrades visibly past ~10km from (0,0,0). To support
// indefinite flight, render coords are kept near origin by periodically
// shifting every world body together. The player sees no pop because the
// shift is uniform.
//
// `galaxyOrigin` is the galaxy-space coordinate currently mapped to render
// (0,0,0):
//   render = galaxy - galaxyOrigin
//   galaxy = render + galaxyOrigin

const DEFAULT_THRESHOLD = 5000;

export class Origin {
  constructor({ threshold = DEFAULT_THRESHOLD } = {}) {
    this.threshold = threshold;
    this.galaxyOrigin = new THREE.Vector3();
  }

  // Called between fixed steps with the plane's current render position. If
  // the plane has drifted past `threshold`, returns the shift vector every
  // world body should add to its render position (so the plane ends up at
  // render origin again). Otherwise returns null.
  maybeRebase(planePos) {
    if (planePos.lengthSq() < this.threshold * this.threshold) return null;
    const shift = planePos.clone().negate();
    this.galaxyOrigin.sub(shift);
    return shift;
  }

  // Map a render-space position to its galaxy-space coordinate.
  toGalaxy(renderPos) {
    return renderPos.clone().add(this.galaxyOrigin);
  }
}
