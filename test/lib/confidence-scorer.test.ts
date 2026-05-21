import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreConfidence } from "../../lib/confidence-scorer.js";

describe("scoreConfidence — tier boundaries with web score", () => {
  it("returns 'auto' when total > 0.95", () => {
    const result = scoreConfidence({ webScore: 1, localeScore: 1, structureScore: 1 });
    // 1*0.45 + 1*0.4 + 1*0.15 = 1.0
    assert.equal(result.tier, "auto");
    assert.ok(result.total > 0.95);
  });

  it("returns 'optional' when total is exactly 0.95", () => {
    // We need total = 0.95 exactly: web*0.45 + locale*0.4 + structure*0.15 = 0.95
    // e.g. web=1, locale=0.875, structure=1 → 0.45 + 0.35 + 0.15 = 0.95
    const result = scoreConfidence({ webScore: 1, localeScore: 0.875, structureScore: 1 });
    assert.equal(result.tier, "optional");
    assert.ok(Math.abs(result.total - 0.95) < 0.001);
  });

  it("returns 'optional' for score in [0.85, 0.95]", () => {
    // web=0.8, locale=0.9, structure=0.8 → 0.36 + 0.36 + 0.12 = 0.84 → escalate
    // web=1, locale=1, structure=0 → 0.45 + 0.4 = 0.85 → optional
    const result = scoreConfidence({ webScore: 1, localeScore: 1, structureScore: 0 });
    assert.equal(result.tier, "optional");
    assert.ok(result.total >= 0.85 && result.total < 0.95);
  });

  it("returns 'escalate' for score in [0.70, 0.85)", () => {
    // web=0.5, locale=0.8, structure=0.7 → 0.225 + 0.32 + 0.105 = 0.65 → mandatory
    // web=0.7, locale=0.9, structure=1 → 0.315 + 0.36 + 0.15 = 0.825 → escalate
    const result = scoreConfidence({ webScore: 0.7, localeScore: 0.9, structureScore: 1 });
    assert.equal(result.tier, "escalate");
    assert.ok(result.total >= 0.7 && result.total < 0.85);
  });

  it("returns 'mandatory' when total < 0.70", () => {
    const result = scoreConfidence({ webScore: 0, localeScore: 0, structureScore: 0 });
    assert.equal(result.tier, "mandatory");
    assert.equal(result.total, 0);
  });
});

describe("scoreConfidence — renormalization without web score", () => {
  it("renormalizes to 1.0 when locale=1 and structure=1", () => {
    const result = scoreConfidence({ localeScore: 1, structureScore: 1 });
    // (1*0.4 + 1*0.15) / 0.55 = 0.55/0.55 = 1.0
    assert.ok(Math.abs(result.total - 1.0) < 0.001);
    assert.equal(result.tier, "auto");
  });

  it("renormalizes correctly at mid-range values", () => {
    // locale=0.7, structure=0.7 → (0.28 + 0.105) / 0.55 = 0.385 / 0.55 = 0.7
    const result = scoreConfidence({ localeScore: 0.7, structureScore: 0.7 });
    assert.ok(Math.abs(result.total - 0.7) < 0.001);
    assert.equal(result.tier, "escalate");
  });

  it("returns 'mandatory' tier when locale=0 and structure=0", () => {
    const result = scoreConfidence({ localeScore: 0, structureScore: 0 });
    assert.equal(result.total, 0);
    assert.equal(result.tier, "mandatory");
  });
});

describe("scoreConfidence — components", () => {
  it("includes web, locale, structure in components", () => {
    const result = scoreConfidence({ webScore: 0.8, localeScore: 0.9, structureScore: 1 });
    assert.equal(result.components.web, 0.8);
    assert.equal(result.components.locale, 0.9);
    assert.equal(result.components.structure, 1);
  });

  it("clamps out-of-range inputs to [0, 1]", () => {
    const result = scoreConfidence({ webScore: 1.5, localeScore: -0.2, structureScore: 2 });
    assert.equal(result.components.web, 1);
    assert.equal(result.components.locale, 0);
    assert.equal(result.components.structure, 1);
  });

  it("treats undefined web as 0 component but does not include in weighting", () => {
    const withWeb = scoreConfidence({ webScore: 0, localeScore: 1, structureScore: 1 });
    const withoutWeb = scoreConfidence({ localeScore: 1, structureScore: 1 });
    // without web → total renormalized to 1.0; with web=0 → 0 + 0.4 + 0.15 = 0.55
    assert.ok(withoutWeb.total > withWeb.total);
  });
});

describe("scoreConfidence — tier boundary at 0.70 exactly", () => {
  it("returns 'escalate' at exactly 0.70", () => {
    // web=1, locale=0, structure=0.333... → 0.45 + 0 + 0.05 = 0.5 → no
    // We need: web*0.45 + locale*0.4 + structure*0.15 = 0.70
    // web=1, locale=0.5, structure=0 → 0.45 + 0.2 = 0.65 → mandatory
    // web=1, locale=0.4375, structure=1 → 0.45 + 0.175 + 0.15 = 0.775 → escalate
    // web=0, locale=1, structure=1 → 0 + 0.4 + 0.15 = 0.55 → mandatory
    // web=0.5, locale=0.5, structure=1 → 0.225 + 0.2 + 0.15 = 0.575 → mandatory
    // Find total = 0.70:
    // web=1, locale=0.125, structure=1 → 0.45 + 0.05 + 0.15 = 0.65 no
    // Let's try: locale=0.625, structure=1, no web → (0.25 + 0.15)/0.55 = 0.4/0.55 ≈ 0.727 escalate
    // Exact 0.70: locale*0.4 + structure*0.15 = 0.70*0.55 = 0.385; if structure=1: locale*0.4 = 0.235 → locale=0.5875
    const result = scoreConfidence({ localeScore: 0.5875, structureScore: 1 });
    assert.ok(Math.abs(result.total - 0.70) < 0.01);
    assert.equal(result.tier, "escalate");
  });
});
