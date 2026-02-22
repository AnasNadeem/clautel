import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Create a temp HOME so DATA_DIR resolves to an isolated directory
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cop-license-test-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;
process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-DEF";
process.env.TELEGRAM_OWNER_ID = "999";

// Dynamic import so env vars are set first
const {
  loadLicense,
  saveLicense,
  defaultLicenseState,
  computeChecksum,
  generateInstanceName,
  checkLicenseForQuery,
  checkLicenseForStartup,
  getLicenseInfo,
  invalidateCache,
  flushLicenseSync,
  TRIAL_DURATION_DAYS,
  getPaymentUrl,
} = await import("../src/license.js");

const { DATA_DIR } = await import("../src/config.js");

const LICENSE_FILE = path.join(DATA_DIR, "license.json");

function cleanup() {
  // Flush any pending debounced writes, then clear cache and file
  flushLicenseSync();
  invalidateCache();
  try { fs.unlinkSync(LICENSE_FILE); } catch {}
}

after(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("license - state I/O", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("defaultLicenseState returns valid trial state", () => {
    const state = defaultLicenseState();
    assert.equal(state.status, "trial");
    assert.equal(state.licenseKey, null);
    assert.equal(state.instanceId, null);
    assert.equal(state.trialStartedAt, null);
    assert.ok(state.checksum, "checksum should be set");
  });

  it("loadLicense returns default when no file exists", () => {
    const state = loadLicense();
    assert.equal(state.status, "trial");
  });

  it("saveLicense and loadLicense round-trip", () => {
    const state = defaultLicenseState();
    state.trialStartedAt = new Date().toISOString();
    saveLicense(state);

    const loaded = loadLicense();
    assert.equal(loaded.trialStartedAt, state.trialStartedAt);
    assert.equal(loaded.status, "trial");
  });

  it("saveLicense creates file with restricted permissions", () => {
    saveLicense(defaultLicenseState());
    const stat = fs.statSync(LICENSE_FILE);
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

describe("license - checksum / anti-tamper", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("computeChecksum produces consistent output", () => {
    const state = defaultLicenseState();
    const { checksum: _, ...rest } = state;
    const cs1 = computeChecksum(rest);
    const cs2 = computeChecksum(rest);
    assert.equal(cs1, cs2);
  });

  it("computeChecksum changes when field changes", () => {
    const state = defaultLicenseState();
    const { checksum: _, ...rest } = state;
    const cs1 = computeChecksum(rest);
    rest.warningsSent = 10;
    const cs2 = computeChecksum(rest);
    assert.notEqual(cs1, cs2);
  });

  it("tampered license.json is detected and treated as expired", () => {
    const state = defaultLicenseState();
    state.warningsSent = 5;
    saveLicense(state);

    // Tamper: change warningsSent but keep old checksum
    const raw = JSON.parse(fs.readFileSync(LICENSE_FILE, "utf-8"));
    raw.warningsSent = 0;
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(raw, null, 2));

    // Must invalidate cache so loadLicense reads the tampered file from disk
    invalidateCache();
    const loaded = loadLicense();
    assert.equal(loaded.status, "expired");
  });

  it("corrupted file returns default state", () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LICENSE_FILE, "not valid json{{{");
    invalidateCache();
    const loaded = loadLicense();
    assert.equal(loaded.status, "trial");
  });
});

describe("license - trial", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("first query initializes trialStartedAt", () => {
    const result = checkLicenseForQuery();
    assert.equal(result.allowed, true);

    // Flush debounced write so we can read from disk
    flushLicenseSync();
    const state = loadLicense();
    assert.ok(state.trialStartedAt, "trialStartedAt should be set");
  });

  it("allows queries within trial period", () => {
    const state = defaultLicenseState();
    state.trialStartedAt = new Date().toISOString();
    saveLicense(state);

    const result = checkLicenseForQuery();
    assert.equal(result.allowed, true);
  });

  it("blocks when trial time expired", () => {
    const state = defaultLicenseState();
    state.trialStartedAt = new Date(
      Date.now() - (TRIAL_DURATION_DAYS + 1) * 24 * 60 * 60 * 1000
    ).toISOString();
    saveLicense(state);

    const result = checkLicenseForQuery();
    assert.equal(result.allowed, false);
    assert.ok(result.reason!.includes("expired"));
  });

  it("shows time warning when 2 days or less remaining", () => {
    const state = defaultLicenseState();
    state.trialStartedAt = new Date(
      Date.now() - (TRIAL_DURATION_DAYS - 1) * 24 * 60 * 60 * 1000
    ).toISOString();
    saveLicense(state);

    const result = checkLicenseForQuery();
    assert.equal(result.allowed, true);
    assert.ok(result.warning, "should have warning at 1 day remaining");
    assert.ok(result.warning!.includes("day"));
  });
});

describe("license - grace period", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("grace status returns allowed with warning", () => {
    const state = defaultLicenseState();
    state.status = "grace";
    state.licenseKey = "test-key";
    state.instanceId = "test-instance";
    state.graceStartedAt = new Date().toISOString();
    saveLicense(state);

    const result = checkLicenseForQuery();
    assert.equal(result.allowed, true);
    assert.ok(result.warning, "should have grace warning");
    assert.ok(result.warning!.includes("lapsed"));
  });

  it("grace period expires after 48h", () => {
    const state = defaultLicenseState();
    state.status = "grace";
    state.licenseKey = "test-key";
    state.instanceId = "test-instance";
    state.graceStartedAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    saveLicense(state);

    const result = checkLicenseForQuery();
    assert.equal(result.allowed, false);
    assert.ok(result.reason!.includes("expired"));
  });
});

describe("license - active status", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("active status is always allowed locally", () => {
    const state = defaultLicenseState();
    state.status = "active";
    state.licenseKey = "test-key";
    state.instanceId = "test-instance";
    state.lastValidatedAt = new Date().toISOString();
    state.lastValidationResult = true;
    saveLicense(state);

    const result = checkLicenseForQuery();
    assert.equal(result.allowed, true);
    assert.equal(result.warning, undefined);
  });
});

describe("license - expired status", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("expired status blocks all queries", () => {
    const state = defaultLicenseState();
    state.status = "expired";
    saveLicense(state);

    const result = checkLicenseForQuery();
    assert.equal(result.allowed, false);
    assert.ok(result.reason!.includes(getPaymentUrl()));
  });
});

describe("license - startup checks", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("allows trial on startup if within limits", async () => {
    const result = await checkLicenseForStartup();
    assert.equal(result.allowed, true);
  });

  it("blocks expired trial on startup", async () => {
    const state = defaultLicenseState();
    state.trialStartedAt = new Date(
      Date.now() - (TRIAL_DURATION_DAYS + 1) * 24 * 60 * 60 * 1000
    ).toISOString();
    saveLicense(state);

    const result = await checkLicenseForStartup();
    assert.equal(result.allowed, false);
  });

  it("blocks expired license on startup", async () => {
    const state = defaultLicenseState();
    state.status = "expired";
    saveLicense(state);

    const result = await checkLicenseForStartup();
    assert.equal(result.allowed, false);
  });
});

describe("license - generateInstanceName", () => {
  it("produces consistent output for same inputs", () => {
    const a = generateInstanceName(999);
    const b = generateInstanceName(999);
    assert.equal(a, b);
  });

  it("produces different output for different owner IDs", () => {
    const a = generateInstanceName(999);
    const b = generateInstanceName(888);
    assert.notEqual(a, b);
  });

  it("returns a 16-char hex string", () => {
    const name = generateInstanceName(999);
    assert.equal(name.length, 16);
    assert.match(name, /^[0-9a-f]+$/);
  });
});

describe("license - getLicenseInfo", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("shows trial info for new installation", () => {
    const info = getLicenseInfo();
    assert.ok(info.includes("trial"));
    assert.ok(info.includes(`${TRIAL_DURATION_DAYS} days`));
  });

  it("shows active info for active license", () => {
    const state = defaultLicenseState();
    state.status = "active";
    state.licenseKey = "abcdef123456";
    state.lastValidatedAt = new Date().toISOString();
    saveLicense(state);

    const info = getLicenseInfo();
    assert.ok(info.includes("Active"));
    assert.ok(info.includes("abcdef12"));
  });

  it("shows grace info for grace period", () => {
    const state = defaultLicenseState();
    state.status = "grace";
    state.graceStartedAt = new Date().toISOString();
    saveLicense(state);

    const info = getLicenseInfo();
    assert.ok(info.includes("Grace"));
    assert.ok(info.includes(getPaymentUrl()));
  });

  it("shows expired info", () => {
    const state = defaultLicenseState();
    state.status = "expired";
    saveLicense(state);

    const info = getLicenseInfo();
    assert.ok(info.includes("Expired"));
    assert.ok(info.includes(getPaymentUrl()));
  });
});
