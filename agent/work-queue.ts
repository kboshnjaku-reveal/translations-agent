import { randomBytes } from "node:crypto";
import type { Bundle } from "./repository.js";
import type { ChangedKey } from "./git.js";

export type Placement =
  | "button_or_menu_item"
  | "label_placeholder_title"
  | "error_message"
  | "tooltip"
  | "notification"
  | "legal_disclaimer"
  | "unspecified";

export type Task = {
  taskId: string;
  bundleId: string;
  sourceLocale: string;
  targetLocale: string;
  keyPath: string;
  newValue: string;
  status: "added" | "modified";
  placement: Placement;
};

export function buildWorkQueue(input: { bundles: Bundle[]; changedByBundle: Map<string, ChangedKey[]> }): Task[] {
  const tasks: Task[] = [];
  for (const bundle of input.bundles) {
    const changes = input.changedByBundle.get(bundle.id) ?? [];
    if (changes.length === 0) continue;
    for (const change of changes) {
      for (const target of bundle.targets) {
        tasks.push({
          taskId: randomBytes(8).toString("hex"),
          bundleId: bundle.id,
          sourceLocale: bundle.sourceLocale,
          targetLocale: target.locale,
          keyPath: change.keyPath,
          newValue: change.newValue,
          status: change.status,
          placement: inferPlacement(change.keyPath),
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
