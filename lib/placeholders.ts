export type Placeholder = { token: string; original: string };

const PLACEHOLDER_REGEX = /\{\{\w+\}\}|\{\w+\}|\$\{\w+\}|%[sd]/g;

export function maskPlaceholders(text: string): { masked: string; placeholders: Placeholder[] } {
  const placeholders: Placeholder[] = [];
  let index = 0;
  const masked = text.replace(PLACEHOLDER_REGEX, (match) => {
    const token = `__PH${index}__`;
    placeholders.push({ token, original: match });
    index += 1;
    return token;
  });
  return { masked, placeholders };
}

export function unmaskPlaceholders(masked: string, placeholders: Placeholder[]): string {
  let out = masked;
  for (const ph of placeholders) {
    out = out.split(ph.token).join(ph.original);
  }
  return out;
}

export function extractPlaceholders(text: string): string[] {
  const found = text.match(PLACEHOLDER_REGEX);
  return found ? [...found] : [];
}

export type StructureCheck = {
  equal: boolean;
  missing: string[];
  extra: string[];
  reordered: boolean;
};

export function comparePlaceholders(source: string, translation: string): StructureCheck {
  const src = extractPlaceholders(source);
  const tgt = extractPlaceholders(translation);

  const srcCounts = countOccurrences(src);
  const tgtCounts = countOccurrences(tgt);

  const missing: string[] = [];
  const extra: string[] = [];

  for (const [key, count] of srcCounts.entries()) {
    const tgtCount = tgtCounts.get(key) ?? 0;
    if (tgtCount < count) {
      for (let i = 0; i < count - tgtCount; i++) missing.push(key);
    }
  }
  for (const [key, count] of tgtCounts.entries()) {
    const srcCount = srcCounts.get(key) ?? 0;
    if (count > srcCount) {
      for (let i = 0; i < count - srcCount; i++) extra.push(key);
    }
  }

  const equal = missing.length === 0 && extra.length === 0;
  const reordered = equal && src.join("|") !== tgt.join("|");

  return { equal, missing, extra, reordered };
}

function countOccurrences(items: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
