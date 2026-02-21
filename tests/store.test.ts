import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Create a temp HOME so config.DATA_DIR resolves to an isolated directory
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cop-test-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-DEF";
process.env.TELEGRAM_OWNER_ID = "999";

// Dynamic import so env vars are set first
const { loadBots, saveBots, addBot, removeBot, getBots } = await import("../src/store.js");
const { config } = await import("../src/config.js");

const botsFile = path.join(config.DATA_DIR, "bots.json");

function cleanup() {
  try { fs.unlinkSync(botsFile); } catch {}
}

after(() => {
  // Restore HOME and clean up temp dir
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const testBot = { id: 1, token: "111:AAA", username: "bot1", workingDir: "/tmp/repo1" };
const testBot2 = { id: 2, token: "222:BBB", username: "bot2", workingDir: "/tmp/repo2" };

describe("store", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("loadBots returns empty array when no file exists", () => {
    assert.deepEqual(loadBots(), []);
  });

  it("saveBots and loadBots round-trip", () => {
    saveBots([testBot]);
    const loaded = loadBots();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 1);
    assert.equal(loaded[0].username, "bot1");
  });

  it("addBot appends a bot", () => {
    addBot(testBot);
    addBot(testBot2);
    const bots = loadBots();
    assert.equal(bots.length, 2);
  });

  it("addBot replaces existing bot with same id", () => {
    addBot(testBot);
    addBot({ ...testBot, workingDir: "/tmp/updated" });
    const bots = loadBots();
    assert.equal(bots.length, 1);
    assert.equal(bots[0].workingDir, "/tmp/updated");
  });

  it("removeBot removes by id", () => {
    addBot(testBot);
    addBot(testBot2);
    removeBot(1);
    const bots = loadBots();
    assert.equal(bots.length, 1);
    assert.equal(bots[0].id, 2);
  });

  it("removeBot is a no-op for non-existent id", () => {
    addBot(testBot);
    removeBot(999);
    assert.equal(loadBots().length, 1);
  });

  it("getBots returns same as loadBots", () => {
    addBot(testBot);
    assert.deepEqual(getBots(), loadBots());
  });

  it("loadBots returns empty array on corrupted file", () => {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(botsFile, "not valid json{{{");
    assert.deepEqual(loadBots(), []);
  });

  it("saveBots creates file with restricted permissions", () => {
    saveBots([testBot]);
    const stat = fs.statSync(botsFile);
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
