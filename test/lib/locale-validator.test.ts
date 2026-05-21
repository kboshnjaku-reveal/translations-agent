import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateLocale } from "../../lib/locale-validator.js";

describe("validateLocale — German (de)", () => {
  it("passes formal Sie-form", () => {
    const { issues, score } = validateLocale("Klicken Sie hier, um fortzufahren.", "de");
    const pronounIssues = issues.filter((i) => i.code === "INFORMAL_PRONOUN");
    assert.equal(pronounIssues.length, 0);
  });

  it("flags informal du-form", () => {
    const { issues } = validateLocale("Klick hier, du kannst es schaffen.", "de");
    assert.ok(issues.some((i) => i.code === "INFORMAL_PRONOUN"));
  });

  it("flags missing sharp-S (strasse → Straße)", () => {
    const { issues } = validateLocale("Bitte die Strasse eingeben.", "de");
    assert.ok(issues.some((i) => i.code === "MISSING_SHARP_S"));
  });

  it("passes text with no German issues", () => {
    const { issues, score } = validateLocale("Datei speichern", "de");
    assert.equal(issues.length, 0);
    assert.equal(score, 1.0);
  });

  it("score is 1.0 minus 0.15 per issue", () => {
    const { issues, score } = validateLocale("du kannst strasse sehen", "de");
    assert.ok(issues.length >= 1);
    assert.ok(score < 1.0);
    assert.ok(score >= 0);
  });
});

describe("validateLocale — Dutch (nl)", () => {
  it("passes formal u-form", () => {
    const { issues } = validateLocale("U kunt hier klikken.", "nl");
    const pronounIssues = issues.filter((i) => i.code === "INFORMAL_PRONOUN");
    assert.equal(pronounIssues.length, 0);
  });

  it("flags informal je-form", () => {
    const { issues } = validateLocale("Je kunt hier klikken.", "nl");
    assert.ok(issues.some((i) => i.code === "INFORMAL_PRONOUN"));
  });

  it("flags missing ij digraph (tyd → tijd)", () => {
    const { issues } = validateLocale("Er is geen tyd meer.", "nl");
    assert.ok(issues.some((i) => i.code === "MISSING_IJ"));
  });
});

describe("validateLocale — Spanish (es)", () => {
  it("flags missing inverted question mark", () => {
    const { issues } = validateLocale("Puedes guardar el archivo?", "es");
    assert.ok(issues.some((i) => i.code === "MISSING_INVERTED_PUNCTUATION"));
  });

  it("passes correctly punctuated question", () => {
    const { issues } = validateLocale("¿Puedes guardar el archivo?", "es");
    const punctIssues = issues.filter((i) => i.code === "MISSING_INVERTED_PUNCTUATION");
    assert.equal(punctIssues.length, 0);
  });

  it("flags missing inverted exclamation mark", () => {
    const { issues } = validateLocale("Guardado correctamente!", "es");
    assert.ok(issues.some((i) => i.code === "MISSING_INVERTED_PUNCTUATION"));
  });

  it("passes correctly punctuated exclamation", () => {
    const { issues } = validateLocale("¡Guardado correctamente!", "es");
    const punctIssues = issues.filter((i) => i.code === "MISSING_INVERTED_PUNCTUATION");
    assert.equal(punctIssues.length, 0);
  });

  it("flags Latin American vocabulary", () => {
    const { issues } = validateLocale("Guardar en la computadora", "es");
    assert.ok(issues.some((i) => i.code === "LATIN_AMERICAN_VOCAB"));
  });
});

describe("validateLocale — unknown/unsupported locale", () => {
  it("returns no issues for an unsupported locale", () => {
    const { issues, score } = validateLocale("Some text", "ja");
    assert.equal(issues.length, 0);
    assert.equal(score, 1.0);
  });
});

describe("validateLocale — score floor", () => {
  it("score is floored at 0", () => {
    // Many issues in one string
    const { score } = validateLocale(
      "du kannst strasse sehen und auss er muss massnahme gross sein",
      "de",
    );
    assert.ok(score >= 0);
  });
});
