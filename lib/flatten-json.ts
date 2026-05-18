export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [k: string]: JsonValue };

export type FlatEntry = { keyPath: string; value: string };

const SEPARATOR = ".";

export function flatten(obj: JsonObject, prefix = ""): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const keyPath = prefix ? `${prefix}${SEPARATOR}${key}` : key;
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      out.push({ keyPath, value });
    } else if (typeof value === "object" && !Array.isArray(value)) {
      out.push(...flatten(value as JsonObject, keyPath));
    }
  }
  return out;
}

export function setDeep(target: JsonObject, keyPath: string, value: string): void {
  const parts = keyPath.split(SEPARATOR);
  let cursor: JsonObject = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const segment = parts[i]!;
    const next = cursor[segment];
    if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as JsonObject;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export function getDeep(source: JsonObject, keyPath: string): string | undefined {
  const parts = keyPath.split(SEPARATOR);
  let cursor: JsonValue | undefined = source;
  for (const part of parts) {
    if (cursor === undefined || cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as JsonObject)[part];
    if (cursor === undefined) return undefined;
  }
  return typeof cursor === "string" ? cursor : undefined;
}
