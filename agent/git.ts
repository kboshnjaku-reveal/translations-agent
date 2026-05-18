import { simpleGit, type SimpleGit } from "simple-git";
import path from "node:path";
import fs from "node:fs/promises";
import { parse as jsoncParse } from "jsonc-parser";
import { flatten, type JsonObject } from "../lib/flatten-json.js";

export type ChangedKey = {
  keyPath: string;
  oldValue: string | null;
  newValue: string;
  status: "added" | "modified";
};

export async function ensureCleanGitState(root: string): Promise<void> {
  const git = makeGit(root);
  const status = await git.status();
  if (status.conflicted.length > 0) {
    throw new Error(`Refusing to run: merge conflicts present in ${status.conflicted.join(", ")}`);
  }
}

export async function detectChangedKeys(root: string, sourceFileAbsPath: string): Promise<ChangedKey[]> {
  const git = makeGit(root);
  const relPath = path.relative(root, sourceFileAbsPath);

  const isTracked = await fileIsTracked(git, relPath);

  if (!isTracked) {
    // Entirely new file: every key is "added"
    const currentText = await fs.readFile(sourceFileAbsPath, "utf8");
    const current = parseLocale(currentText, relPath);
    return flatten(current).map((e) => ({
      keyPath: e.keyPath,
      oldValue: null,
      newValue: e.value,
      status: "added" as const,
    }));
  }

  const currentText = await fs.readFile(sourceFileAbsPath, "utf8");
  const previousText = await git.show([`HEAD:${relPath}`]).catch(() => null);

  if (previousText === null) {
    // Tracked but no HEAD version (e.g. fresh repo). Treat all as added.
    const current = parseLocale(currentText, relPath);
    return flatten(current).map((e) => ({
      keyPath: e.keyPath,
      oldValue: null,
      newValue: e.value,
      status: "added" as const,
    }));
  }

  const current = parseLocale(currentText, relPath);
  const previous = parseLocale(previousText, relPath + "@HEAD");

  const prevMap = new Map(flatten(previous).map((e) => [e.keyPath, e.value]));
  const changed: ChangedKey[] = [];
  for (const entry of flatten(current)) {
    const old = prevMap.get(entry.keyPath);
    if (old === undefined) {
      changed.push({ keyPath: entry.keyPath, oldValue: null, newValue: entry.value, status: "added" });
    } else if (old !== entry.value) {
      changed.push({ keyPath: entry.keyPath, oldValue: old, newValue: entry.value, status: "modified" });
    }
  }
  return changed;
}

function makeGit(root: string): SimpleGit {
  return simpleGit({ baseDir: root, binary: "git", maxConcurrentProcesses: 4 });
}

async function fileIsTracked(git: SimpleGit, relPath: string): Promise<boolean> {
  try {
    const result = await git.raw(["ls-files", "--error-unmatch", relPath]);
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

function parseLocale(text: string, label: string): JsonObject {
  const errors: import("jsonc-parser").ParseError[] = [];
  const parsed = jsoncParse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Malformed JSON in ${label}: ${errors.map((e) => e.error).join(", ")}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Locale file ${label} must be a JSON object at root.`);
  }
  return parsed as JsonObject;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const git = makeGit(root);
    await git.revparse(["--git-dir"]);
    return true;
  } catch {
    return false;
  }
}
