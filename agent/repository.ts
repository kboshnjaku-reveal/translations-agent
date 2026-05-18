import path from "node:path";
import fs from "node:fs/promises";
import fg from "fast-glob";
import { parse as jsoncParse } from "jsonc-parser";
import { flatten, type JsonObject, type FlatEntry } from "../lib/flatten-json.js";

export type LocaleFile = {
  locale: string;
  absPath: string;
  relPath: string;
  json: JsonObject;
  entries: FlatEntry[];
};

export type Bundle = {
  id: string;
  dir: string;
  sourceLocale: string;
  sourceFile: LocaleFile;
  targets: LocaleFile[];
  /** true when locale JSON files wrap their content in a root key matching the locale name, e.g. {"en": {...}} */
  localeWrapper: boolean;
};

const LOCALE_GLOBS = [
  "**/locales/**/*.json",
  "**/i18n/**/*.json",
  "**/translations/**/*.json",
  "**/messages/**/*.json",
];

const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.git/**",
  "**/.next/**",
  "**/out/**",
];

const ENGLISH_LOCALE_NAMES = ["en", "en-us", "en_us", "en-gb", "en_gb", "english"];

export async function scanRepository(root: string, overrideSourceLocale?: string): Promise<Bundle[]> {
  const matches = await fg(LOCALE_GLOBS, {
    cwd: root,
    ignore: IGNORE_PATTERNS,
    absolute: true,
    dot: false,
  });

  const byDir = new Map<string, string[]>();
  for (const abs of matches) {
    const dir = path.dirname(abs);
    const list = byDir.get(dir) ?? [];
    list.push(abs);
    byDir.set(dir, list);
  }

  const bundles: Bundle[] = [];

  for (const [dir, files] of byDir.entries()) {
    if (files.length < 2) continue;

    const localeFiles: LocaleFile[] = [];
    for (const abs of files) {
      const locale = path.basename(abs, ".json");
      const text = await fs.readFile(abs, "utf8");
      const errors: import("jsonc-parser").ParseError[] = [];
      const json = jsoncParse(text, errors, { allowTrailingComma: true });
      if (errors.length > 0) {
        throw new Error(`Malformed JSON in ${abs}: ${errors.map((e) => e.error).join(", ")}`);
      }
      if (json === null || typeof json !== "object" || Array.isArray(json)) {
        throw new Error(`Locale file ${abs} must be a JSON object at root.`);
      }
      const obj = json as JsonObject;
      localeFiles.push({
        locale,
        absPath: abs,
        relPath: path.relative(root, abs),
        json: obj,
        entries: flatten(obj),
      });
    }

    const sourceLocale = pickSourceLocale(localeFiles, overrideSourceLocale);
    if (!sourceLocale) continue;

    const sourceFile = localeFiles.find((f) => f.locale === sourceLocale)!;
    const targets = localeFiles.filter((f) => f.locale !== sourceLocale);
    if (targets.length === 0) continue;

    // Detect locale-wrapper pattern: source JSON has a single root key equal to the locale name
    const sourceTopKeys = Object.keys(sourceFile.json);
    const localeWrapper =
      sourceTopKeys.length === 1 &&
      sourceTopKeys[0]!.toLowerCase() === sourceLocale.toLowerCase();

    bundles.push({
      id: path.relative(root, dir) || ".",
      dir,
      sourceLocale,
      sourceFile,
      targets,
      localeWrapper,
    });
  }

  return bundles;
}

function pickSourceLocale(files: LocaleFile[], override?: string): string | undefined {
  if (override) {
    const match = files.find((f) => f.locale.toLowerCase() === override.toLowerCase());
    if (match) return match.locale;
  }
  for (const preferred of ["en", "en-US", "en-us", "en_US"]) {
    const match = files.find((f) => f.locale.toLowerCase() === preferred.toLowerCase());
    if (match) return match.locale;
  }
  // Any English-looking file
  const englishLike = files.find((f) => ENGLISH_LOCALE_NAMES.includes(f.locale.toLowerCase()));
  return englishLike?.locale;
}
