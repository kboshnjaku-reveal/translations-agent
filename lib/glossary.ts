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

  const sourceMap = new Map<string, string>();
  for (const e of source.entries) sourceMap.set(e.keyPath, e.value);

  const candidateCounts = new Map<string, { source: string; translations: Map<string, Map<string, number>> }>();

  let processedPairs = 0;
  let skippedMissingInSource = 0;
  let skippedShortTerms = 0;
  let skippedWordCountMismatch = 0;

  for (const target of targets) {
    for (const targetEntry of target.entries) {
      const sourceValue = sourceMap.get(targetEntry.keyPath);
      if (!sourceValue) {
        skippedMissingInSource++;
        continue;
      }
      processedPairs++;

      const srcTerms = extractTerms(sourceValue);
      const tgtTerms = extractTerms(targetEntry.value);

      for (let i = 0; i < srcTerms.length; i++) {
        for (let j = i + 1; j <= Math.min(i + MAX_WORDS, srcTerms.length); j++) {
          const srcPhrase = srcTerms.slice(i, j).join(" ");
          if (!srcPhrase || srcPhrase.length < 3) {
            skippedShortTerms++;
            continue;
          }

          // Find the best-matching target phrase of same word count
          const wordCount = j - i;
          if (tgtTerms.length < wordCount) {
            skippedWordCountMismatch++;
            continue;
          }

          const normalizedSrc = normalize(srcPhrase);
          let bestTgt: string | null = null;

          // If keepEnglish hint or term appears verbatim in target → keepEnglish path
          if (containsVerbatim(targetEntry.value, srcPhrase)) {
            bestTgt = srcPhrase;
          } else {
            // Heuristic: pick the target phrase of same length most likely to align (first match)
            // We'll deduplicate later; here we just record any candidate
            bestTgt = tgtTerms.slice(0, wordCount).join(" ");
          }
          if (!bestTgt) continue;

          const entry = candidateCounts.get(normalizedSrc) ?? {
            source: srcPhrase,
            translations: new Map<string, Map<string, number>>(),
          };
          const localeMap = entry.translations.get(target.locale) ?? new Map<string, number>();
          localeMap.set(bestTgt, (localeMap.get(bestTgt) ?? 0) + 1);
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
    if (translations.size < MIN_LOCALE_COVERAGE) {
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

  console.warn(`[glossary] Candidates: ${candidateCounts.size}, skipped by MIN_LOCALE_COVERAGE(${MIN_LOCALE_COVERAGE}): ${skippedByCoverage}, before dedup: ${glossary.length}`);

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
