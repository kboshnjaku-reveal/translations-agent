import fs from "node:fs/promises";
import path from "node:path";
import { parse as jsoncParse } from "jsonc-parser";
import { setDeep, type JsonObject } from "../lib/flatten-json.js";
import { comparePlaceholders } from "../lib/placeholders.js";

export type Update = {
  targetLocale: string;
  keyPath: string;
  value: string;
  needsReview: boolean;
  failureReason?: string;
};

export type CommitResult = {
  written: string[];
  rejected: Array<{ keyPath: string; targetLocale: string; reason: string }>;
};

export type ResolveTargetPath = (targetLocale: string) => { absPath: string; sourceValue: string | undefined } | undefined;

/**
 * Atomically merge updates into target locale files for a single bundle.
 *
 * Each target locale gets one atomic write (tmp file + rename). Updates that fail the
 * server-side placeholder structure check are rejected; the per-locale write proceeds
 * only with the surviving updates.
 */
export async function commitBundleUpdates(
  resolve: ResolveTargetPath,
  updates: Update[],
  options: { sourceByKey: Map<string, string> },
): Promise<CommitResult> {
  const written: string[] = [];
  const rejected: CommitResult["rejected"] = [];

  // Server-side placeholder structure check (belt + suspenders)
  const survivors: Update[] = [];
  for (const update of updates) {
    const source = options.sourceByKey.get(update.keyPath);
    if (source !== undefined) {
      const check = comparePlaceholders(source, update.value);
      if (!check.equal && !update.needsReview) {
        rejected.push({
          keyPath: update.keyPath,
          targetLocale: update.targetLocale,
          reason: `Placeholder structure mismatch (missing: ${check.missing.join(",")}, extra: ${check.extra.join(",")})`,
        });
        continue;
      }
    }
    survivors.push(update);
  }

  // Group by target locale
  const byLocale = new Map<string, Update[]>();
  for (const u of survivors) {
    const list = byLocale.get(u.targetLocale) ?? [];
    list.push(u);
    byLocale.set(u.targetLocale, list);
  }

  for (const [locale, localeUpdates] of byLocale.entries()) {
    const resolved = resolve(locale);
    if (!resolved) {
      for (const u of localeUpdates) {
        rejected.push({ keyPath: u.keyPath, targetLocale: locale, reason: `No target file resolved for locale ${locale}` });
      }
      continue;
    }
    const { absPath } = resolved;
    const text = await fs.readFile(absPath, "utf8");
    const errors: import("jsonc-parser").ParseError[] = [];
    const parsed = jsoncParse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      for (const u of localeUpdates) {
        rejected.push({ keyPath: u.keyPath, targetLocale: locale, reason: `Existing target JSON is malformed; refused write` });
      }
      continue;
    }
    const target: JsonObject =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};

    for (const u of localeUpdates) {
      setDeep(target, u.keyPath, u.value);
      if (u.needsReview) {
        setDeep(target, `${u.keyPath}__needsReview`, "true");
      }
    }

    const serialized = JSON.stringify(target, null, 2) + "\n";
    const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, serialized, "utf8");
    await fs.rename(tmpPath, absPath);
    written.push(path.basename(absPath));
  }

  return { written, rejected };
}
