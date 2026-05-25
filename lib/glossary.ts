import type { FlatEntry } from "./flatten-json.js";

export type GlossaryEntry = {
  source: string;
  translations: Record<string, string>;
  keepEnglish: boolean;
};

export type GlossaryMatch = {
  term: string;
  translation: string;
  keepEnglish: boolean;
};

export type LocaleEntries = {
  locale: string;
  entries: FlatEntry[];
};

const MAX_WORDS = 4;
const MIN_LOCALE_COVERAGE = 2;
const KEEP_ENGLISH_HINTS = new Set([
  "API",
  "Relativity",
  "Nuix",
  "Concordance",
  "Bates",
  "ESI",
  "Slack",
  "ID",
  "URL",
  "JSON",
  "CSV",
  "PDF",
  "Microsoft",
  "Google",
]);

export function buildGlossary(sources: LocaleEntries[], sourceLocale: string): GlossaryEntry[] {
  const source = sources.find((s) => s.locale === sourceLocale);
  if (!source) {
    console.warn(`[glossary] No source locale found for '${sourceLocale}'. Available: ${sources.map(s => s.locale).join(', ')}`);
    return [];
  }

  const targets = sources.filter((s) => s.locale !== sourceLocale);
  if (targets.length === 0) {
    console.warn(`[glossary] No target locales found. Source: ${sourceLocale}`);
    return [];
  }

  // Require presence in at least MIN_LOCALE_COVERAGE locales, but never more than exist.
  const minCoverage = Math.max(1, Math.min(MIN_LOCALE_COVERAGE, targets.length));

  const sourceMap = new Map<string, string>();
  for (const e of stripLocalePrefix(source.entries, sourceLocale)) sourceMap.set(e.keyPath, e.value);

  const candidateCounts = new Map<string, { source: string; translations: Map<string, Map<string, number>> }>();

  let processedPairs = 0;
  let skippedMissingInSource = 0;

  for (const target of targets) {
    for (const targetEntry of stripLocalePrefix(target.entries, target.locale)) {
      const sourceValue = sourceMap.get(targetEntry.keyPath);
      if (!sourceValue) {
        skippedMissingInSource++;
        continue;
      }
      processedPairs++;

      const srcTerms = extractTerms(sourceValue);
      const tgtTerms = extractTerms(targetEntry.value);
      if (srcTerms.length === 0 || tgtTerms.length === 0) continue;

      // Whole-value extraction: only when the source value fits within MAX_WORDS.
      // Avoids the positional-alignment problem that arises when slicing sub-phrases
      // out of longer sentences (different languages reorder words).
      if (srcTerms.length <= MAX_WORDS) {
        const srcPhrase = srcTerms.join(" ");
        if (srcPhrase.length >= 3) {
          const normalizedSrc = normalize(srcPhrase);
          const tgt = containsVerbatim(targetEntry.value, srcPhrase)
            ? srcPhrase
            : tgtTerms.join(" ");
          const entry = candidateCounts.get(normalizedSrc) ?? {
            source: srcPhrase,
            translations: new Map<string, Map<string, number>>(),
          };
          const localeMap = entry.translations.get(target.locale) ?? new Map<string, number>();
          localeMap.set(tgt, (localeMap.get(tgt) ?? 0) + 1);
          entry.translations.set(target.locale, localeMap);
          candidateCounts.set(normalizedSrc, entry);
        }
      }
    }
  }

  console.warn(`[glossary] Processing: source entries=${source.entries.length}, target locales=${targets.length}, total target entries=${targets.reduce((a, t) => a + t.entries.length, 0)}, processed pairs=${processedPairs}, skipped (missing in source)=${skippedMissingInSource}`);

  const glossary: GlossaryEntry[] = [];
  let skippedByCoverage = 0;
  for (const { source: src, translations } of candidateCounts.values()) {
    if (translations.size < minCoverage) {
      skippedByCoverage++;
      continue;
    }

    const resolved: Record<string, string> = {};
    let allKeepEnglish = true;
    for (const [locale, localeMap] of translations.entries()) {
      const best = pickMostFrequent(localeMap);
      if (!best) continue;
      resolved[locale] = best;
      if (normalize(best) !== normalize(src)) allKeepEnglish = false;
    }
    const keepEnglish = allKeepEnglish || KEEP_ENGLISH_HINTS.has(src.split(" ")[0] ?? "");
    glossary.push({ source: src, translations: resolved, keepEnglish });
  }

  console.warn(`[glossary] Candidates: ${candidateCounts.size}, skipped by minCoverage(${minCoverage}): ${skippedByCoverage}, before dedup: ${glossary.length}`);

  // Longest-first for greedy matching
  glossary.sort((a, b) => b.source.length - a.source.length);

  // Deduplicate overlaps: if a longer phrase covers a shorter one, the shorter is allowed only if it has distinct translation
  const deduped = dedupeOverlaps(glossary);
  console.warn(`[glossary] After dedupeOverlaps: ${deduped.length}`);
  return deduped;
}

// Merge seed entries (manually curated) with auto-built ones. Seed wins for any source term it covers.
export function mergeWithSeed(autoBuilt: GlossaryEntry[], seed: GlossaryEntry[]): GlossaryEntry[] {
  const seedSources = new Set(seed.map((e) => normalize(e.source)));
  const filtered = autoBuilt.filter((e) => !seedSources.has(normalize(e.source)));
  console.warn(`[glossary] mergeWithSeed: autoBuilt=${autoBuilt.length}, seed=${seed.length}, filtered (non-conflicting autoBuilt)=${filtered.length}`);
  
  const merged = [...seed, ...filtered];
  merged.sort((a, b) => b.source.length - a.source.length);
  const final = dedupeOverlaps(merged);
  console.warn(`[glossary] After final dedupeOverlaps: ${final.length}`);
  return final;
}

export function findExactMatch(
  glossary: GlossaryEntry[],
  text: string,
  targetLocale: string,
): string | null {
  const needle = normalize(text);
  const base = targetLocale.split("-")[0] ?? targetLocale;

  for (const entry of glossary) {
    if (normalize(entry.source) !== needle) continue;

    if (entry.keepEnglish) return text;

    const translation =
      entry.translations[targetLocale] ?? entry.translations[base];
    return translation ?? null;
  }

  return null;
}

export function findMatches(glossary: GlossaryEntry[], text: string, targetLocale: string): GlossaryMatch[] {
  const matches: GlossaryMatch[] = [];
  const consumedRanges: Array<[number, number]> = [];

  for (const entry of glossary) {
    const re = new RegExp(`\\b${escapeRegex(entry.source)}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (consumedRanges.some(([s, e]) => start < e && end > s)) continue;
      const translation = entry.translations[targetLocale];
      if (!translation && !entry.keepEnglish) continue;
      matches.push({
        term: m[0],
        translation: entry.keepEnglish ? m[0] : translation!,
        keepEnglish: entry.keepEnglish,
      });
      consumedRanges.push([start, end]);
    }
  }

  return matches;
}

function stripLocalePrefix(entries: FlatEntry[], locale: string): FlatEntry[] {
  const prefix = locale + ".";
  if (entries.length > 0 && entries[0]!.keyPath.startsWith(prefix)) {
    return entries.map((e) => ({ ...e, keyPath: e.keyPath.slice(prefix.length) }));
  }
  return entries;
}

function extractTerms(text: string): string[] {
  return text
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function containsVerbatim(haystack: string, needle: string): boolean {
  return new RegExp(`\\b${escapeRegex(needle)}\\b`, "i").test(haystack);
}

function pickMostFrequent(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [term, count] of counts.entries()) {
    if (count > bestCount) {
      best = term;
      bestCount = count;
    }
  }
  return best;
}

function dedupeOverlaps(entries: GlossaryEntry[]): GlossaryEntry[] {
  const kept: GlossaryEntry[] = [];
  for (const entry of entries) {
    const norm = normalize(entry.source);
    const overlaps = kept.some((k) => {
      const knorm = normalize(k.source);
      if (knorm === norm) return true;
      if (knorm.includes(norm) || norm.includes(knorm)) {
        // overlap; keep only if translations differ
        return Object.entries(entry.translations).every(
          ([locale, t]) => normalize(k.translations[locale] ?? "") === normalize(t),
        );
      }
      return false;
    });
    if (!overlaps) kept.push(entry);
  }
  return kept;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
