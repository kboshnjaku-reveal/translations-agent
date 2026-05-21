import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { commitBundleUpdates } from "../../agent/locale-writer.js";
import type { ResolveTargetPath, Update } from "../../agent/locale-writer.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "locale-writer-test-"));
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

describe("commitBundleUpdates — basic writes", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await makeTempDir();
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a new key to an existing locale file", async () => {
    const deFile = path.join(tmpDir, "de.json");
    await writeJson(deFile, { home: { title: "Willkommen" } });

    const resolve: ResolveTargetPath = (locale) => {
      if (locale === "de") return { absPath: deFile, sourceValue: undefined };
      return undefined;
    };

    const updates: Update[] = [
      { targetLocale: "de", keyPath: "home.subtitle", value: "Melden Sie sich an", needsReview: false },
    ];

    const result = await commitBundleUpdates(resolve, updates, {
      sourceByKey: new Map([["home.subtitle", "Sign in to continue"]]),
    });

    assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.written, ["de.json"]);

    const written = await readJson(deFile) as Record<string, unknown>;
    assert.equal((written.home as Record<string, unknown>)?.subtitle, "Melden Sie sich an");
  });

  it("preserves existing keys when adding new ones", async () => {
    const deFile = path.join(tmpDir, "de-preserve.json");
    await writeJson(deFile, { home: { title: "Willkommen" } });

    const resolve: ResolveTargetPath = (locale) =>
      locale === "de" ? { absPath: deFile, sourceValue: undefined } : undefined;

    const updates: Update[] = [
      { targetLocale: "de", keyPath: "home.subtitle", value: "Anmelden", needsReview: false },
    ];

    await commitBundleUpdates(resolve, updates, {
      sourceByKey: new Map([["home.subtitle", "Sign in"]]),
    });

    const result = await readJson(deFile) as Record<string, unknown>;
    const home = result.home as Record<string, unknown>;
    assert.equal(home?.title, "Willkommen");
    assert.equal(home?.subtitle, "Anmelden");
  });
});

describe("commitBundleUpdates — placeholder structure check", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await makeTempDir();
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects an update that drops a placeholder (needsReview=false)", async () => {
    const deFile = path.join(tmpDir, "de.json");
    await writeJson(deFile, {});

    const resolve: ResolveTargetPath = (locale) =>
      locale === "de" ? { absPath: deFile, sourceValue: undefined } : undefined;

    const updates: Update[] = [
      {
        targetLocale: "de",
        keyPath: "msg",
        value: "Hallo Welt",  // missing {{name}}
        needsReview: false,
      },
    ];

    const result = await commitBundleUpdates(resolve, updates, {
      sourceByKey: new Map([["msg", "Hello {{name}}"]]),
    });

    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]!.keyPath, "msg");
    assert.ok(result.rejected[0]!.reason.includes("mismatch"));
  });

  it("allows an update that drops a placeholder when needsReview=true", async () => {
    const deFile = path.join(tmpDir, "de-review.json");
    await writeJson(deFile, {});

    const resolve: ResolveTargetPath = (locale) =>
      locale === "de" ? { absPath: deFile, sourceValue: undefined } : undefined;

    const updates: Update[] = [
      {
        targetLocale: "de",
        keyPath: "msg",
        value: "Hallo Welt",
        needsReview: true,  // review flag bypasses server-side check
      },
    ];

    const result = await commitBundleUpdates(resolve, updates, {
      sourceByKey: new Map([["msg", "Hello {{name}}"]]),
    });

    assert.equal(result.rejected.length, 0);
    assert.equal(result.written.length, 1);
  });

  it("writes needsReview sibling key", async () => {
    const deFile = path.join(tmpDir, "de-needsreview.json");
    await writeJson(deFile, {});

    const resolve: ResolveTargetPath = (locale) =>
      locale === "de" ? { absPath: deFile, sourceValue: undefined } : undefined;

    const updates: Update[] = [
      {
        targetLocale: "de",
        keyPath: "home.title",
        value: "Willkommen",
        needsReview: true,
      },
    ];

    await commitBundleUpdates(resolve, updates, {
      sourceByKey: new Map(),
    });

    const written = await readJson(deFile) as Record<string, unknown>;
    const home = written.home as Record<string, unknown>;
    assert.equal(home?.title, "Willkommen");
    assert.equal(home?.["title__needsReview"], "true");
  });
});

describe("commitBundleUpdates — dry-run", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await makeTempDir();
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not write to disk in dry-run mode but reports written", async () => {
    const deFile = path.join(tmpDir, "de.json");
    const original = { home: { title: "Willkommen" } };
    await writeJson(deFile, original);

    const resolve: ResolveTargetPath = (locale) =>
      locale === "de" ? { absPath: deFile, sourceValue: undefined } : undefined;

    const updates: Update[] = [
      { targetLocale: "de", keyPath: "home.subtitle", value: "Anmelden", needsReview: false },
    ];

    const result = await commitBundleUpdates(resolve, updates, {
      sourceByKey: new Map([["home.subtitle", "Sign in"]]),
      dryRun: true,
    });

    assert.equal(result.written.length, 1);
    assert.deepEqual(result.rejected, []);

    // File on disk should be unchanged
    const onDisk = await readJson(deFile) as Record<string, unknown>;
    const home = onDisk.home as Record<string, unknown>;
    assert.equal(home?.subtitle, undefined, "dry-run must not write to disk");
  });
});

describe("commitBundleUpdates — resolve returns undefined", () => {
  it("rejects updates when target locale file cannot be resolved", async () => {
    const resolve: ResolveTargetPath = () => undefined;

    const updates: Update[] = [
      { targetLocale: "fr", keyPath: "home.title", value: "Accueil", needsReview: false },
    ];

    const result = await commitBundleUpdates(resolve, updates, {
      sourceByKey: new Map(),
    });

    assert.equal(result.written.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]!.targetLocale, "fr");
  });
});
