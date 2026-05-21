import { randomBytes } from "node:crypto";
import type { Bundle } from "./repository.js";
import type { ChangedKey } from "./git.js";
import { maskPlaceholders, normalizeWhitespace } from "../lib/placeholders.js";
import { classifyDomain } from "../lib/domain-classifier.js";
import type { Placeholder } from "../lib/placeholders.js";
import type { Domain } from "../lib/domain-classifier.js";

export type Placement =
  | "button_or_menu_item"
  | "label_placeholder_title"
  | "error_message"
  | "tooltip"
  | "notification"
  | "legal_disclaimer"
  | "unspecified";

export type PreNormalized = {
  normalized: string;
  original: string;
  placeholders: Placeholder[];
};

export type PreClassified = {
  domain: Domain;
  confidence: number;
  hits: Record<string, number>;
};

export type Task = {
  taskId: string;
  bundleId: string;
  sourceLocale: string;
  targetLocale: string;
  keyPath: string;
  /** The new (current) source value to translate. */
  newValue: string;
  /**
   * The previous source value from git HEAD, or null for added keys.
   * Present on modified keys so the translation_memory tool can compute
   * what changed between the old and new source string.
   */
  oldValue: string | null;
  status: "added" | "modified";
  placement: Placement;
  preNormalized: PreNormalized;
  preClassified: PreClassified;
};

export function buildWorkQueue(input: { bundles: Bundle[]; changedByBundle: Map<string, ChangedKey[]> }): Task[] {
  const tasks: Task[] = [];
  // Keyed by bundleId::keyPath — same source text across all target locales shares one computation.
  const cache = new Map<string, { preNormalized: PreNormalized; preClassified: PreClassified }>();

  for (const bundle of input.bundles) {
    const changes = input.changedByBundle.get(bundle.id) ?? [];
    if (changes.length === 0) continue;
    for (const change of changes) {
      const cacheKey = `${bundle.id}::${change.keyPath}`;
      if (!cache.has(cacheKey)) {
        const original = normalizeWhitespace(change.newValue);
        const { masked, placeholders } = maskPlaceholders(original);
        cache.set(cacheKey, {
          preNormalized: { normalized: masked, original, placeholders },
          preClassified: classifyDomain(change.newValue),
        });
      }
      const precomputed = cache.get(cacheKey)!;
      for (const target of bundle.targets) {
        tasks.push({
          taskId: randomBytes(8).toString("hex"),
          bundleId: bundle.id,
          sourceLocale: bundle.sourceLocale,
          targetLocale: target.locale,
          keyPath: change.keyPath,
          newValue: change.newValue,
          oldValue: change.oldValue,
          status: change.status,
          placement: inferPlacement(change.keyPath),
          ...precomputed,
        });
      }
    }
  }
  return tasks;
}

const PLACEMENT_PATTERNS: Array<[RegExp, Placement]> = [
  [/(^|\.)(btn|button|action|menu|cta)(\.|$)/i, "button_or_menu_item"],
  [/(^|\.)(error|err|errors|failure|invalid)(\.|$)/i, "error_message"],
  [/(^|\.)(tooltip|hint|help)(\.|$)/i, "tooltip"],
  [/(^|\.)(notification|toast|alert|notice)(\.|$)/i, "notification"],
  [/(^|\.)(legal|disclaimer|terms|privacy|tos)(\.|$)/i, "legal_disclaimer"],
  [/(^|\.)(label|title|placeholder|heading|header)(\.|$)/i, "label_placeholder_title"],
];

export function inferPlacement(keyPath: string): Placement {
  for (const [re, placement] of PLACEMENT_PATTERNS) {
    if (re.test(keyPath)) return placement;
  }
  return "unspecified";
}
