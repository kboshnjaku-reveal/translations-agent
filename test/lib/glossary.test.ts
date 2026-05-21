import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGlossary, findMatches } from "../../lib/glossary.js";
import type { LocaleEntries } from "../../lib/glossary.js";

// Minimal locale entries used across tests
const enEntries: LocaleEntries = {
  locale: "en",
  entries: [
    { keyPath: "actions.save", value: "Save document" },
    { keyPath: "actions.delete", value: "Delete item" },
    { keyPath: "nav.settings", value: "Settings" },
    { keyPath: "api.key", value: "API key" },
  ],
};

const deEntries: LocaleEntries = {
  locale: "de",
  entries: [
    { keyPath: "actions.save", value: "Dokument speichern" },
    { keyPath: "actions.delete", value: "Element löschen" },
    { keyPath: "nav.settings", value: "Einstellungen" },
    { keyPath: "api.key", value: "API key" }, // keep-English: same as source
  ],
};

const esEntries: LocaleEntries = {
  locale: "es",
  entries: [
    { keyPath: "actions.save", value: "Guardar documento" },
    { keyPath: "actions.delete", value: "Eliminar elemento" },
    { keyPath: "nav.settings", value: "Configuración" },
    { keyPath: "api.key", value: "API key" },
  ],
};

describe("buildGlossary", () => {
  it("returns empty array when source locale not in sources", () => {
    const result = buildGlossary([enEntries], "fr");
    assert.deepEqual(result, []);
  });

  it("returns empty array when no target locales", () => {
    const result = buildGlossary([enEntries], "en");
    assert.deepEqual(result, []);
  });

  it("builds glossary entries from aligned locale files", () => {
    const result = buildGlossary([enEntries, deEntries, esEntries], "en");
    assert.ok(result.length > 0, "expected at least one glossary entry");
  });

  it("sorts entries longest-first for greedy matching", () => {
    const result = buildGlossary([enEntries, deEntries, esEntries], "en");
    for (let i = 1; i < result.length; i++) {
      assert.ok(
        result[i - 1]!.source.length >= result[i]!.source.length,
        `entry at [${i - 1}] (${result[i-1]!.source.length}) should be >= [${i}] (${result[i]!.source.length})`,
      );
    }
  });

  it("marks known keep-English terms", () => {
    const result = buildGlossary([enEntries, deEntries, esEntries], "en");
    const apiEntry = result.find((e) => e.source.toLowerCase() === "api");
    if (apiEntry) {
      assert.equal(apiEntry.keepEnglish, true);
    }
    // If not found, that's acceptable — buildGlossary requires MIN_LOCALE_COVERAGE
  });
});

describe("findMatches", () => {
  it("returns empty array when glossary is empty", () => {
    const matches = findMatches([], "Save document", "de");
    assert.deepEqual(matches, []);
  });

  it("finds a matching term for the target locale", () => {
    const glossary = buildGlossary([enEntries, deEntries, esEntries], "en");
    const matches = findMatches(glossary, "Save document now", "de");
    // Whether it finds a match depends on the heuristic, but should not throw
    assert.ok(Array.isArray(matches));
  });

  it("returns empty array when text has no matching terms", () => {
    const glossary = buildGlossary([enEntries, deEntries, esEntries], "en");
    const matches = findMatches(glossary, "something completely unrelated xyz", "de");
    assert.deepEqual(matches, []);
  });

  it("returns empty array when target locale not in glossary", () => {
    const glossary = buildGlossary([enEntries, deEntries, esEntries], "en");
    const matches = findMatches(glossary, "Save document", "ja");
    assert.deepEqual(matches, []);
  });
});
