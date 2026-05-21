import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraceRegistry, REQUIRED_PRE_VALIDATE } from "../../lib/trace.js";

describe("TraceRegistry — issue and verify", () => {
  it("issues a token for a given step and task", () => {
    const reg = new TraceRegistry();
    const token = reg.issue("task1", "normalize");
    assert.ok(token.startsWith("normalize_"), `expected token to start with 'normalize_', got '${token}'`);
  });

  it("verifies a presented token correctly", () => {
    const reg = new TraceRegistry();
    const token = reg.issue("task1", "normalize");
    const result = reg.verify("task1", [token], ["normalize"]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
  });

  it("fails verification when token not presented", () => {
    const reg = new TraceRegistry();
    reg.issue("task1", "normalize");
    const result = reg.verify("task1", [], ["normalize"]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["normalize"]);
  });

  it("fails verification for unknown taskId", () => {
    const reg = new TraceRegistry();
    const result = reg.verify("unknown", [], ["normalize"]);
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes("normalize"));
  });

  it("fails verification when wrong token is presented", () => {
    const reg = new TraceRegistry();
    reg.issue("task1", "normalize");
    const result = reg.verify("task1", ["normalize_wrongtoken"], ["normalize"]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["normalize"]);
  });

  it("reports all missing steps", () => {
    const reg = new TraceRegistry();
    const normalizeToken = reg.issue("task1", "normalize");
    // glossary, classify, locale_rules not issued
    const result = reg.verify("task1", [normalizeToken], REQUIRED_PRE_VALIDATE);
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes("glossary"));
    assert.ok(result.missing.includes("classify"));
    assert.ok(result.missing.includes("locale_rules"));
    assert.ok(!result.missing.includes("normalize"));
  });
});

describe("TraceRegistry — issueForMany", () => {
  it("issues a shared token for multiple task IDs", () => {
    const reg = new TraceRegistry();
    const token = reg.issueForMany(["task1", "task2", "task3"], "normalize");
    assert.ok(token.startsWith("normalize_"));
  });

  it("same token verifies for all registered task IDs", () => {
    const reg = new TraceRegistry();
    const token = reg.issueForMany(["task1", "task2"], "normalize");
    const r1 = reg.verify("task1", [token], ["normalize"]);
    const r2 = reg.verify("task2", [token], ["normalize"]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
  });

  it("does not verify for a task not in the group", () => {
    const reg = new TraceRegistry();
    const token = reg.issueForMany(["task1", "task2"], "normalize");
    const r = reg.verify("task3", [token], ["normalize"]);
    assert.equal(r.ok, false);
  });
});

describe("TraceRegistry — reset", () => {
  it("clears all tokens for a task after reset", () => {
    const reg = new TraceRegistry();
    const token = reg.issue("task1", "normalize");
    reg.reset("task1");
    const result = reg.verify("task1", [token], ["normalize"]);
    assert.equal(result.ok, false);
  });

  it("does not affect other tasks", () => {
    const reg = new TraceRegistry();
    const t1 = reg.issue("task1", "normalize");
    const t2 = reg.issue("task2", "normalize");
    reg.reset("task1");
    const r2 = reg.verify("task2", [t2], ["normalize"]);
    assert.equal(r2.ok, true);
  });
});

describe("REQUIRED_PRE_VALIDATE constant", () => {
  it("contains the four required pipeline steps", () => {
    assert.deepEqual(REQUIRED_PRE_VALIDATE, ["normalize", "glossary", "classify", "locale_rules"]);
  });
});
