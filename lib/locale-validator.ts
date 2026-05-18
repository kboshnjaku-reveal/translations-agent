export type LocaleIssue = {
  code: LocaleIssueCode;
  expected?: string;
  actual?: string;
};

export type LocaleIssueCode =
  | "INFORMAL_PRONOUN"
  | "WRONG_QUOTE_STYLE"
  | "MISSING_INVERTED_PUNCTUATION"
  | "LATIN_AMERICAN_VOCAB"
  | "MISSING_SHARP_S"
  | "MISSING_IJ"
  | "STRUCTURE_DIVERGED";

const RULES: Record<string, { pronouns: RegExp[]; localeId: string }> = {
  de: {
    pronouns: [/\b(du|dich|dir|dein|deine|deinen|deiner|deines|deinem)\b/gi],
    localeId: "de",
  },
  nl: {
    pronouns: [/\b(je|jij|jou|jouw|jullie)\b/gi],
    localeId: "nl",
  },
  es: {
    pronouns: [],
    localeId: "es",
  },
};

const LATIN_AMERICAN_VOCAB = [
  // Heuristic list — flag if appears
  /\b(computadora|celular|carro|departamento|jugo|durazno|frutilla|piscina|saco)\b/gi,
];

export function validateLocale(translation: string, locale: string): { issues: LocaleIssue[]; score: number } {
  const issues: LocaleIssue[] = [];

  const base = locale.split("-")[0]!;
  const rule = RULES[base];
  if (rule) {
    for (const re of rule.pronouns) {
      const match = translation.match(re);
      if (match) {
        issues.push({ code: "INFORMAL_PRONOUN", actual: match[0], expected: formalPronoun(base) });
      }
    }
  }

  if (base === "de") {
    // Soft heuristic: penalize "ss" where ß is commonly expected after long vowels
    // Common cases: "groß", "Straße", "Maßnahme", "Schloss" (exception). Keep this minimal — high-confidence cases only.
    const knownSharpS = [
      [/\bgross(e|er|en|es|em)?\b/gi, "groß…"],
      [/\bstrasse\b/gi, "Straße"],
      [/\bmassnahme/gi, "Maßnahme"],
      [/\bauss(er|erhalb|erdem)\b/gi, "auß…"],
    ] as const;
    for (const [re, expected] of knownSharpS) {
      const m = translation.match(re);
      if (m) issues.push({ code: "MISSING_SHARP_S", actual: m[0], expected });
    }
  }

  if (base === "nl") {
    // Soft heuristic: flag "y" appearing where "ij" is canonical — only the most common
    const knownIJ = [
      [/\btyd\b/gi, "tijd"],
      [/\bzyn\b/gi, "zijn"],
      [/\bbylage\b/gi, "bijlage"],
    ] as const;
    for (const [re, expected] of knownIJ) {
      const m = translation.match(re);
      if (m) issues.push({ code: "MISSING_IJ", actual: m[0], expected });
    }
  }

  if (base === "es") {
    // Inverted punctuation: question/exclamation sentences must start with ¿ or ¡
    const sentences = translation.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      if (/\?$/.test(trimmed) && !trimmed.startsWith("¿")) {
        issues.push({ code: "MISSING_INVERTED_PUNCTUATION", actual: trimmed, expected: "¿…?" });
      }
      if (/!$/.test(trimmed) && !trimmed.startsWith("¡")) {
        issues.push({ code: "MISSING_INVERTED_PUNCTUATION", actual: trimmed, expected: "¡…!" });
      }
    }
    for (const re of LATIN_AMERICAN_VOCAB) {
      const m = translation.match(re);
      if (m) issues.push({ code: "LATIN_AMERICAN_VOCAB", actual: m[0] });
    }
  }

  // Score: 1.0 minus 0.15 per issue, floored at 0
  const score = Math.max(0, 1 - issues.length * 0.15);
  return { issues, score };
}

function formalPronoun(base: string): string {
  if (base === "de") return "Sie/Ihnen/Ihr";
  if (base === "nl") return "u/uw";
  return "";
}
