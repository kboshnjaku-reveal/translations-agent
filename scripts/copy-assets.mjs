#!/usr/bin/env node
// Copies runtime asset directories from the repo root into dist/ so the
// compiled binary can resolve them via the same relative paths it uses in dev
// (path.dirname(import.meta.url) + "..").
//
// Run after `tsc`. Idempotent — clears the destination before copying.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

const ASSET_DIRS = ["data", "prompts"];

// Walk `src` and mirror it into `dest` using writeFile (truncate + write).
// We avoid `fs.cp` and `fs.rm` because both call `unlink` internally, which
// fails on bind mounts that allow create but not unlink (e.g. macOS-backed
// volumes inside Linux containers used for CI). writeFile keeps the existing
// inode and overwrites in place, which works on every filesystem we care about.
async function mirror(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await mirror(s, d);
    } else if (entry.isFile()) {
      const data = await readFile(s);
      await writeFile(d, data);
    }
  }
}

for (const dir of ASSET_DIRS) {
  await mirror(path.join(repoRoot, dir), path.join(distDir, dir));
  console.log(`copied ${dir}/ -> dist/${dir}/`);
}
