import * as THREE from 'three';

// Animated sea (Phase 15c — life). The terrain's sea is a flat, vertex-
// colored shell at 0.995·R; this is a slightly larger sphere drawn over it
// so land (always ≥ R) pokes through and water areas get rippled normals,
// a sun glint, a pale Fresnel rim at grazing angles, and a slow color
// swell. Opaque (no sort issues), fogged like the rest of the scene.
//
// One shared time uniform for every planet's water; main.js ticks it and
// feeds each planet's sun direction (same pass as the atmosphere shells).

export const WATER_TIME = { value: 0 };

const SEA_R = 0.9962;

export function buildWater(planet) {
  const geom = new THREE.SphereGeometry(planet.radius * SEA_R, 96, 64);
  const material = new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uColor: { value: new THREE.Color(planet.palette?.water || '#21507e') },
        uSky: { value: new THREE.Color(planet.palette?.sky || '#9ac4e8') },
        uSunDir: { value: new THREE.Vector3(1, 0.5, 0.3).normalize() },
        uSunColor: { value: new THREE.Color(0xfff2d6) },
        uFlow: { value: new THREE.Vector3(0.37, 0.11, 0.92).normalize() },
      },
    ]),
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      varying vec3 vLocal;   // planet-local position (stable under rebases)
      varying vec3 vWorld;
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      #include <fog_pars_fragment>
      uniform vec3 uColor, uSky, uSunDir, uSunColor, uFlow;
      uniform float uTime;
      varying vec3 vLocal;
      varying vec3 vWorld;

      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash(i), n100 = hash(i + vec3(1,0,0)), n010 = hash(i + vec3(0,1,0)), n110 = hash(i + vec3(1,1,0));
        float n001 = hash(i + vec3(0,0,1)), n101 = hash(i + vec3(1,0,1)), n011 = hash(i + vec3(0,1,1)), n111 = hash(i + vec3(1,1,1));
        return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
                   mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
      }
      float waves(vec3 p) {
        return vnoise(p * 0.35 + uFlow * uTime * 0.6) * 0.6
             + vnoise(p * 0.9 - uFlow.zxy * uTime * 1.1) * 0.3
             + vnoise(p * 2.1 + uFlow.yzx * uTime * 1.7) * 0.1;
      }
      void main() {
        vec3 n = normalize(vLocal);
        // Finite-difference ripple normal in the tangent plane.
        vec3 t1 = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0,1,0) : vec3(1,0,0)));
        vec3 t2 = cross(n, t1);
        float e = 0.6;
        float h0 = waves(vLocal);
        float hx = waves(vLocal + t1 * e);
        float hy = waves(vLocal + t2 * e);
        vec3 wn = normalize(n - (t1 * (hx - h0) + t2 * (hy - h0)) * 1.4);
        // modelMatrix is translation-only for planets → local normal = world normal.
        vec3 V = normalize(cameraPosition - vWorld);
        float day = smoothstep(-0.15, 0.3, dot(n, uSunDir));
        float lambert = max(dot(wn, uSunDir), 0.0);
        float fres = pow(1.0 - max(dot(wn, V), 0.0), 4.0);
        vec3 H = normalize(uSunDir + V);
        float glint = pow(max(dot(wn, H), 0.0), 180.0) * day;
        vec3 deep = uColor * (0.18 + 0.75 * lambert * day + 0.12);
        vec3 col = mix(deep, uSky * (0.25 + 0.75 * day), fres * 0.55);
        col += uColor * (h0 - 0.5) * 0.18;          // slow swell tint
        col += uSunColor * glint * 1.6;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
  material.uniforms.uTime = WATER_TIME;
  const mesh = new THREE.Mesh(geom, material);
  mesh.userData.matSlot = 'terrain'; // exempt from the MaterialSet audit, like the terrain
  mesh.name = 'water';
  return {
    mesh,
    setSun(dir, color) {
      material.uniforms.uSunDir.value.copy(dir);
      if (color) material.uniforms.uSunColor.value.copy(color);
    },
    setPalette(palette) {
      if (palette?.water) material.uniforms.uColor.value.set(palette.water);
      if (palette?.sky) material.uniforms.uSky.value.set(palette.sky);
    },
    dispose() { geom.dispose(); material.dispose(); },
  };
}
