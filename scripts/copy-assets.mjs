#!/usr/bin/env node
// Copies runtime asset directories from the repo root into dist/ so the
// compiled binary can resolve them via the same relative paths it uses in dev
// (path.dirname(import.meta.url) + "..").
//
// Run after `tsc`. Idempotent — clears the destination before copying.

import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");

const ASSET_DIRS = ["data", "prompts"];

for (const dir of ASSET_DIRS) {
  const src = path.join(repoRoot, dir);
  const dest = path.join(distDir, dir);
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
  console.log(`copied ${dir}/ -> dist/${dir}/`);
}
