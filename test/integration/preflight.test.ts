import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepository } from "../../agent/repository.js";
import { buildWorkQueue } from "../../agent/work-queue.js";
import type { ChangedKey } from "../../agent/git.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "../../fixtures/sample-repo");

describe("scanRepository — fixture", () => {
  it("finds the sample-repo bundle", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    assert.equal(bundles.length, 1, "expected exactly one bundle in fixtures/sample-repo");
  });

  it("identifies en as source locale", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    const bundle = bundles[0]!;
    assert.equal(bundle.sourceLocale, "en");
  });

  it("includes de, es, nl as target locales", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    const bundle = bundles[0]!;
    const locales = bundle.targets.map((t) => t.locale).sort();
    assert.deepEqual(locales, ["de", "es", "nl"]);
  });

  it("source file has entries with keyPaths and string values", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    const bundle = bundles[0]!;
    assert.ok(bundle.sourceFile.entries.length > 0, "source file should have flat entries");
    for (const entry of bundle.sourceFile.entries) {
      assert.ok(typeof entry.keyPath === "string");
      assert.ok(typeof entry.value === "string");
    }
  });

  it("bundle id is a non-empty string", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    assert.ok(bundles[0]!.id.length > 0);
  });
});

describe("buildWorkQueue — with synthetic changed keys", () => {
  it("produces one task per (changed key × target locale)", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    const bundle = bundles[0]!;

    const changedKeys: ChangedKey[] = [
      { keyPath: "home.title", oldValue: "Welcome", newValue: "Welcome back", status: "modified" },
    ];
    const changedByBundle = new Map([[bundle.id, changedKeys]]);

    const tasks = buildWorkQueue({ bundles, changedByBundle });

    // 1 changed key × 3 target locales = 3 tasks
    assert.equal(tasks.length, 3, "expected 3 tasks for 1 changed key × 3 target locales");
    const targetLocales = tasks.map((t) => t.targetLocale).sort();
    assert.deepEqual(targetLocales, ["de", "es", "nl"]);
  });

  it("produces correct task shape", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    const bundle = bundles[0]!;

    const changedKeys: ChangedKey[] = [
      { keyPath: "home.title", oldValue: null, newValue: "Welcome", status: "added" },
    ];
    const changedByBundle = new Map([[bundle.id, changedKeys]]);

    const tasks = buildWorkQueue({ bundles, changedByBundle });

    for (const task of tasks) {
      assert.ok(typeof task.taskId === "string" && task.taskId.length > 0);
      assert.equal(task.bundleId, bundle.id);
      assert.equal(task.sourceLocale, "en");
      assert.equal(task.keyPath, "home.title");
      assert.equal(task.newValue, "Welcome");
      assert.ok(["de", "es", "nl"].includes(task.targetLocale));
      assert.ok(task.preNormalized != null);
      assert.ok(task.preClassified != null);
    }
  });

  it("returns empty array when no changes", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    const changedByBundle = new Map<string, ChangedKey[]>();
    const tasks = buildWorkQueue({ bundles, changedByBundle });
    assert.equal(tasks.length, 0);
  });

  it("produces multiple tasks for multiple changed keys", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    const bundle = bundles[0]!;

    const changedKeys: ChangedKey[] = [
      { keyPath: "home.title", oldValue: null, newValue: "Welcome", status: "added" },
      { keyPath: "home.subtitle", oldValue: null, newValue: "Sign in", status: "added" },
    ];
    const changedByBundle = new Map([[bundle.id, changedKeys]]);

    const tasks = buildWorkQueue({ bundles, changedByBundle });

    // 2 keys × 3 locales = 6 tasks
    assert.equal(tasks.length, 6);
  });

  it("infers placement from keyPath patterns", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    const bundle = bundles[0]!;

    const changedKeys: ChangedKey[] = [
      { keyPath: "nav.button.save", oldValue: null, newValue: "Save", status: "added" },
      { keyPath: "error.upload_failed", oldValue: null, newValue: "Upload failed", status: "added" },
      { keyPath: "checkout.label.name", oldValue: null, newValue: "Name", status: "added" },
    ];
    const changedByBundle = new Map([[bundle.id, changedKeys]]);

    const tasks = buildWorkQueue({ bundles, changedByBundle });

    const buttonTask = tasks.find((t) => t.keyPath === "nav.button.save");
    const errorTask = tasks.find((t) => t.keyPath === "error.upload_failed");
    const labelTask = tasks.find((t) => t.keyPath === "checkout.label.name");

    assert.equal(buttonTask?.placement, "button_or_menu_item");
    assert.equal(errorTask?.placement, "error_message");
    assert.equal(labelTask?.placement, "label_placeholder_title");
  });

  it("preNormalized masks placeholders before agent sees them", async () => {
    const bundles = await scanRepository(FIXTURE_ROOT);
    const bundle = bundles[0]!;

    const changedKeys: ChangedKey[] = [
      { keyPath: "msg.greet", oldValue: null, newValue: "Hello {{name}}", status: "added" },
    ];
    const changedByBundle = new Map([[bundle.id, changedKeys]]);

    const tasks = buildWorkQueue({ bundles, changedByBundle });
    const task = tasks[0]!;

    assert.equal(task.preNormalized.normalized, "Hello __PH0__");
    assert.equal(task.preNormalized.placeholders.length, 1);
    assert.equal(task.preNormalized.placeholders[0]!.original, "{{name}}");
  });
});
