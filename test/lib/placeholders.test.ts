import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  maskPlaceholders,
  unmaskPlaceholders,
  extractPlaceholders,
  comparePlaceholders,
} from "../../lib/placeholders.js";

describe("maskPlaceholders", () => {
  it("masks double-brace placeholders", () => {
    const { masked, placeholders } = maskPlaceholders("Hello {{name}}!");
    assert.equal(masked, "Hello __PH0__!");
    assert.deepEqual(placeholders, [{ token: "__PH0__", original: "{{name}}" }]);
  });

  it("masks single-brace placeholders", () => {
    const { masked, placeholders } = maskPlaceholders("Hello {name}!");
    assert.equal(masked, "Hello __PH0__!");
    assert.deepEqual(placeholders, [{ token: "__PH0__", original: "{name}" }]);
  });

  it("masks dollar-brace placeholders", () => {
    const { masked, placeholders } = maskPlaceholders("Hello ${name}!");
    assert.equal(masked, "Hello __PH0__!");
    assert.deepEqual(placeholders, [{ token: "__PH0__", original: "${name}" }]);
  });

  it("masks printf %s and %d", () => {
    const { masked, placeholders } = maskPlaceholders("Found %d items by %s");
    assert.equal(masked, "Found __PH0__ items by __PH1__");
    assert.equal(placeholders.length, 2);
    assert.equal(placeholders[0]!.original, "%d");
    assert.equal(placeholders[1]!.original, "%s");
  });

  it("masks multiple mixed placeholders", () => {
    const { masked, placeholders } = maskPlaceholders("{{a}} and {b} and ${c}");
    assert.equal(masked, "__PH0__ and __PH1__ and __PH2__");
    assert.equal(placeholders.length, 3);
  });

  it("returns empty array for no placeholders", () => {
    const { masked, placeholders } = maskPlaceholders("No placeholders here.");
    assert.equal(masked, "No placeholders here.");
    assert.deepEqual(placeholders, []);
  });
});

describe("unmaskPlaceholders", () => {
  it("restores a single placeholder", () => {
    const { masked, placeholders } = maskPlaceholders("Hello {{name}}!");
    assert.equal(unmaskPlaceholders(masked, placeholders), "Hello {{name}}!");
  });

  it("round-trips double-brace", () => {
    const s = "Save {{count}} files";
    const { masked, placeholders } = maskPlaceholders(s);
    assert.equal(unmaskPlaceholders(masked, placeholders), s);
  });

  it("round-trips printf", () => {
    const s = "Found %d items by %s";
    const { masked, placeholders } = maskPlaceholders(s);
    assert.equal(unmaskPlaceholders(masked, placeholders), s);
  });

  it("round-trips dollar-brace", () => {
    const s = "Value is ${x} and ${y}";
    const { masked, placeholders } = maskPlaceholders(s);
    assert.equal(unmaskPlaceholders(masked, placeholders), s);
  });

  it("round-trips text with no placeholders", () => {
    const s = "Plain text, no tokens.";
    const { masked, placeholders } = maskPlaceholders(s);
    assert.equal(unmaskPlaceholders(masked, placeholders), s);
  });
});

describe("extractPlaceholders", () => {
  it("extracts all placeholder types", () => {
    const result = extractPlaceholders("{{a}} {b} ${c} %s %d");
    assert.deepEqual(result, ["{{a}}", "{b}", "${c}", "%s", "%d"]);
  });

  it("returns empty array for plain text", () => {
    assert.deepEqual(extractPlaceholders("Hello world"), []);
  });

  it("handles duplicates", () => {
    const result = extractPlaceholders("{{a}} and {{a}}");
    assert.deepEqual(result, ["{{a}}", "{{a}}"]);
  });
});

describe("comparePlaceholders", () => {
  it("returns equal for identical placeholders", () => {
    const result = comparePlaceholders("Hello {{name}}", "Hallo {{name}}");
    assert.equal(result.equal, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
    assert.equal(result.reordered, false);
  });

  it("detects missing placeholder in translation", () => {
    const result = comparePlaceholders("Hello {{name}}", "Hallo");
    assert.equal(result.equal, false);
    assert.deepEqual(result.missing, ["{{name}}"]);
    assert.deepEqual(result.extra, []);
  });

  it("detects extra placeholder in translation", () => {
    const result = comparePlaceholders("Hello", "Hallo {{name}}");
    assert.equal(result.equal, false);
    assert.deepEqual(result.extra, ["{{name}}"]);
    assert.deepEqual(result.missing, []);
  });

  it("detects reordered placeholders", () => {
    const result = comparePlaceholders("{{a}} then {{b}}", "{{b}} dann {{a}}");
    assert.equal(result.equal, true);
    assert.equal(result.reordered, true);
  });

  it("handles no placeholders in either string", () => {
    const result = comparePlaceholders("Hello world", "Hallo Welt");
    assert.equal(result.equal, true);
    assert.equal(result.reordered, false);
  });

  it("handles duplicate placeholders correctly", () => {
    const result = comparePlaceholders("{{a}} and {{a}}", "{{a}} und {{a}}");
    assert.equal(result.equal, true);
  });

  it("detects when one of duplicate placeholders is missing", () => {
    const result = comparePlaceholders("{{a}} and {{a}}", "{{a}} und");
    assert.equal(result.equal, false);
    assert.deepEqual(result.missing, ["{{a}}"]);
  });

  it("handles mixed types", () => {
    const result = comparePlaceholders("Found %d items for {{user}}", "Gefunden %d Elemente für {{user}}");
    assert.equal(result.equal, true);
  });
});
