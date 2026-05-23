#!/usr/bin/env node
// Copies Three.js Draco + Basis Universal decoder files from node_modules into
// public/ so Vite serves them at /draco/ and /basis/ at runtime. The GLB
// loader calls setDecoderPath('/draco/') and setTranscoderPath('/basis/');
// these decoders are fetched lazily by the browser on first GLB that needs
// them. Idempotent — safe to re-run.

import { mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const PAIRS = [
  { from: 'node_modules/three/examples/jsm/libs/draco/gltf', to: 'public/draco' },
  { from: 'node_modules/three/examples/jsm/libs/basis',      to: 'public/basis' },
];

async function copyDir(srcRel, dstRel) {
  const src = join(root, srcRel);
  const dst = join(root, dstRel);
  if (!existsSync(src)) {
    console.warn(`[copy-decoders] missing: ${srcRel} — skipping`);
    return 0;
  }
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src);
  let count = 0;
  for (const name of entries) {
    const s = join(src, name);
    if ((await stat(s)).isFile()) {
      await copyFile(s, join(dst, name));
      count++;
    }
  }
  return count;
}

let total = 0;
for (const { from, to } of PAIRS) {
  const n = await copyDir(from, to);
  total += n;
  console.log(`[copy-decoders] ${from} → ${to}  (${n} files)`);
}
console.log(`[copy-decoders] done. ${total} files copied.`);
