import { randomBytes } from "node:crypto";

export type TraceStep =
  | "normalize"
  | "glossary"
  | "classify"
  | "locale_rules"
  | "validate"
  | "web"
  | "score";

export const REQUIRED_PRE_VALIDATE: TraceStep[] = ["normalize", "glossary", "classify", "locale_rules"];

export type TraceState = {
  taskId: string;
  tokens: Map<TraceStep, string>;
};

export class TraceRegistry {
  private states = new Map<string, TraceState>();

  open(taskId: string): TraceState {
    let state = this.states.get(taskId);
    if (!state) {
      state = { taskId, tokens: new Map() };
      this.states.set(taskId, state);
    }
    return state;
  }

  issue(taskId: string, step: TraceStep): string {
    const state = this.open(taskId);
    const token = `${step}_${randomBytes(6).toString("hex")}`;
    state.tokens.set(step, token);
    return token;
  }

  verify(taskId: string, presented: string[], required: TraceStep[]): { ok: boolean; missing: TraceStep[] } {
    const state = this.states.get(taskId);
    if (!state) return { ok: false, missing: required };
    const presentedSet = new Set(presented);
    const missing: TraceStep[] = [];
    for (const step of required) {
      const expected = state.tokens.get(step);
      if (!expected || !presentedSet.has(expected)) missing.push(step);
    }
    return { ok: missing.length === 0, missing };
  }

  reset(taskId: string): void {
    this.states.delete(taskId);
  }
}
