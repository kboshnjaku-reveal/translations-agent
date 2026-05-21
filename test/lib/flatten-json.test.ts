import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flatten, setDeep, getDeep } from "../../lib/flatten-json.js";
import type { JsonObject } from "../../lib/flatten-json.js";

describe("flatten", () => {
  it("flattens a single-level object", () => {
    const result = flatten({ a: "hello", b: "world" });
    assert.deepEqual(result, [
      { keyPath: "a", value: "hello" },
      { keyPath: "b", value: "world" },
    ]);
  });

  it("flattens nested objects with dot-separated paths", () => {
    const result = flatten({ nav: { button: { save: "Save" } } });
    assert.deepEqual(result, [{ keyPath: "nav.button.save", value: "Save" }]);
  });

  it("skips null values", () => {
    const result = flatten({ a: "hello", b: null });
    assert.deepEqual(result, [{ keyPath: "a", value: "hello" }]);
  });

  it("skips array values", () => {
    const result = flatten({ a: "hello", b: ["x", "y"] } as JsonObject);
    assert.deepEqual(result, [{ keyPath: "a", value: "hello" }]);
  });

  it("skips number and boolean values", () => {
    const result = flatten({ a: "hello", b: 42, c: true } as JsonObject);
    assert.deepEqual(result, [{ keyPath: "a", value: "hello" }]);
  });

  it("handles an empty object", () => {
    const result = flatten({});
    assert.deepEqual(result, []);
  });

  it("flattens multi-level nesting", () => {
    const result = flatten({ home: { title: "Welcome", subtitle: "Sign in" } });
    assert.deepEqual(result, [
      { keyPath: "home.title", value: "Welcome" },
      { keyPath: "home.subtitle", value: "Sign in" },
    ]);
  });
});

describe("setDeep", () => {
  it("sets a top-level key", () => {
    const obj: JsonObject = {};
    setDeep(obj, "a", "hello");
    assert.deepEqual(obj, { a: "hello" });
  });

  it("creates nested objects as needed", () => {
    const obj: JsonObject = {};
    setDeep(obj, "nav.button.save", "Save");
    assert.deepEqual(obj, { nav: { button: { save: "Save" } } });
  });

  it("merges into an existing nested structure", () => {
    const obj: JsonObject = { nav: { button: { save: "Save" } } };
    setDeep(obj, "nav.button.cancel", "Cancel");
    assert.deepEqual(obj, { nav: { button: { save: "Save", cancel: "Cancel" } } });
  });

  it("overwrites an existing value", () => {
    const obj: JsonObject = { a: "old" };
    setDeep(obj, "a", "new");
    assert.deepEqual(obj, { a: "new" });
  });

  it("replaces non-object intermediate nodes", () => {
    const obj: JsonObject = { nav: "was a string" };
    setDeep(obj, "nav.button.save", "Save");
    assert.deepEqual(obj, { nav: { button: { save: "Save" } } });
  });
});

describe("getDeep", () => {
  it("retrieves a top-level string value", () => {
    const obj: JsonObject = { a: "hello" };
    assert.equal(getDeep(obj, "a"), "hello");
  });

  it("retrieves a nested value", () => {
    const obj: JsonObject = { nav: { button: { save: "Save" } } };
    assert.equal(getDeep(obj, "nav.button.save"), "Save");
  });

  it("returns undefined for missing key", () => {
    const obj: JsonObject = { a: "hello" };
    assert.equal(getDeep(obj, "b"), undefined);
  });

  it("returns undefined for missing nested key", () => {
    const obj: JsonObject = { nav: { button: {} } };
    assert.equal(getDeep(obj, "nav.button.save"), undefined);
  });

  it("returns undefined when path traverses non-object", () => {
    const obj: JsonObject = { nav: "string" };
    assert.equal(getDeep(obj, "nav.button"), undefined);
  });

  it("returns undefined for non-string leaf", () => {
    const obj: JsonObject = { count: 42 } as JsonObject;
    assert.equal(getDeep(obj, "count"), undefined);
  });

  it("round-trips with setDeep", () => {
    const obj: JsonObject = {};
    setDeep(obj, "home.title", "Welcome");
    assert.equal(getDeep(obj, "home.title"), "Welcome");
  });
});
