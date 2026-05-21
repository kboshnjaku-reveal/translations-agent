import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────────

export type Checkpoint = {
  schema: 1;
  timestamp: string;
  headSha: string;
  /** bundleId → SHA-256 of source file contents at run start */
  sourceDigests: Record<string, string>;
  /** Key groups that have been fully committed in this run */
  completed: Array<{ bundleId: string; keyPath: string }>;
};

// ── Paths ──────────────────────────────────────────────────────────────────────

const CHECKPOINT_DIR = ".translations-agent";
const CHECKPOINT_FILE = "state.json";

function checkpointPath(root: string): string {
  return path.join(root, CHECKPOINT_DIR, CHECKPOINT_FILE);
}

// ── Load ───────────────────────────────────────────────────────────────────────

/**
 * Reads the checkpoint from disk. Returns `null` if the file is absent, cannot
 * be parsed, or has an unrecognised schema version.
 */
export async function loadCheckpoint(root: string): Promise<Checkpoint | null> {
  const filePath = checkpointPath(root);
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).schema !== 1
    ) {
      return null;
    }
    return parsed as Checkpoint;
  } catch {
    return null;
  }
}

// ── Save ───────────────────────────────────────────────────────────────────────

/**
 * Atomically writes the checkpoint using a temp-file + rename pattern. Creates
 * the `.translations-agent/` directory if it does not exist.
 */
export async function saveCheckpoint(root: string, checkpoint: Checkpoint): Promise<void> {
  const dir = path.join(root, CHECKPOINT_DIR);
  await fs.mkdir(dir, { recursive: true });
  const filePath = checkpointPath(root);
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

// ── Delete ─────────────────────────────────────────────────────────────────────

/**
 * Removes the checkpoint file. Silently ignores "file not found" errors so
 * callers do not need to guard for a missing checkpoint.
 */
export async function deleteCheckpoint(root: string): Promise<void> {
  const filePath = checkpointPath(root);
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore — checkpoint may not exist.
  }
}

// ── Validation ─────────────────────────────────────────────────────────────────

/**
 * Returns `true` if the checkpoint is still valid for the current run — i.e.
 * HEAD has not moved and none of the source files have changed since the
 * checkpoint was written.
 */
export function isCheckpointValid(
  checkpoint: Checkpoint,
  currentHead: string,
  currentSourceDigests: Record<string, string>,
): boolean {
  if (checkpoint.headSha !== currentHead) return false;
  for (const [bundleId, digest] of Object.entries(checkpoint.sourceDigests)) {
    if (currentSourceDigests[bundleId] !== digest) return false;
  }
  return true;
}

// ── Digest helper ──────────────────────────────────────────────────────────────

/** Returns a SHA-256 hex digest of a file's string contents. */
export function digestContents(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}
