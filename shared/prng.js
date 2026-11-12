// Hashed PRNG + seed hashing. Same seed → same world.
//
// Lives in /shared because BOTH the game (src/) and the worker (worker/)
// import it: the worker re-derives a planet's dice from its seeds instead
// of trusting what the client sends. Keep this file dependency-free and
// free of DOM / three.js imports.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function hashSeeds(...nums) {
  let h = 2166136261 >>> 0;
  for (const n of nums) {
    const x = ((n | 0) ^ Math.floor(n * 1e6 | 0)) >>> 0;
    h ^= x;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// FNV-1a over the UTF-16 code units of a string. Deterministic across runs and
// platforms; collisions are fine here since we only use it to seed a PRNG.
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
