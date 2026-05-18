export type ConfidenceTier = "auto" | "optional" | "escalate" | "mandatory";

export type ConfidenceResult = {
  total: number;
  tier: ConfidenceTier;
  components: { web: number; locale: number; structure: number };
};

export function scoreConfidence(opts: {
  webScore?: number;
  localeScore: number;
  structureScore: number;
}): ConfidenceResult {
  const web = clamp01(opts.webScore);
  const locale = clamp01(opts.localeScore);
  const structure = clamp01(opts.structureScore);

  // If web validation wasn't run, redistribute its 0.45 weight to locale/structure proportionally
  const hasWeb = opts.webScore !== undefined;
  let total: number;
  if (hasWeb) {
    total = web * 0.45 + locale * 0.4 + structure * 0.15;
  } else {
    // locale*0.4 + structure*0.15 = 0.55 total weight → renormalize to 1.0
    total = (locale * 0.4 + structure * 0.15) / 0.55;
  }

  let tier: ConfidenceTier;
  if (total > 0.95) tier = "auto";
  else if (total >= 0.85) tier = "optional";
  else if (total >= 0.7) tier = "escalate";
  else tier = "mandatory";

  return { total, tier, components: { web, locale, structure } };
}

function clamp01(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
