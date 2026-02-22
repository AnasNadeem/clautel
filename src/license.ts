import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";

// --- Constants ---

const VALIDATION_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const OFFLINE_GRACE_HOURS = 72;
const GRACE_PERIOD_MS = 48 * 60 * 60 * 1000; // 48 hours
const DODO_CHECKOUT_URL = "https://checkout.dodopayments.com";
const DODO_BASE_URL = "https://live.dodopayments.com";
const SUCCESS_PAGE_URL = "https://whoareyouanas.com/claude-on-phone/success";

export type PlanTier = "pro" | "max";

const PAYMENT_PRODUCTS: Record<PlanTier, string> = {
  pro: "pdt_Y3kYZzaXSo6v7Y0zYhLjb",
  max: "pdt_PLACEHOLDER_MAX_PRODUCT", // TODO: replace with real Dodo product ID
};

const PLAN_LABELS: Record<PlanTier, string> = {
  pro: "Pro ($4/mo)",
  max: "Max ($9/mo)",
};

const LICENSE_FILE = path.join(DATA_DIR, "license.json");
const FLUSH_DEBOUNCE_MS = 5000; // 5 seconds

// Anti-tamper: embedded as byte array so it's not a readable string in source/dist
const INTEGRITY_KEY = Buffer.from([
  0x63, 0x6c, 0x61, 0x75, 0x64, 0x65, 0x2d, 0x6f, 0x6e, 0x2d, 0x70, 0x68,
  0x6f, 0x6e, 0x65, 0x2d, 0x69, 0x6e, 0x74, 0x65, 0x67, 0x72, 0x69, 0x74,
  0x79, 0x2d, 0x6b, 0x65, 0x79, 0x2d, 0x76, 0x31,
]);

// --- Types ---

export interface LicenseState {
  licenseKey: string | null;
  instanceId: string | null;
  status: "active" | "grace" | "expired";
  plan: PlanTier;
  lastValidatedAt: string | null;
  lastValidationResult: boolean;
  graceStartedAt: string | null;
  warningsSent: number;
  checksum: string;
}

export interface LicenseCheckResult {
  allowed: boolean;
  warning?: string;
  reason?: string;
}

// --- Helpers ---

export function getPaymentUrl(plan: PlanTier = "pro"): string {
  const product = PAYMENT_PRODUCTS[plan];
  const redirect = encodeURIComponent(SUCCESS_PAGE_URL);
  return `${DODO_CHECKOUT_URL}/buy/${product}?quantity=1&redirect_url=${redirect}`;
}

export function getPlanLabel(plan: PlanTier): string {
  return PLAN_LABELS[plan];
}

export function detectClaudePlan(): { tier: PlanTier } {
  const claudeConfigPath = path.join(os.homedir(), ".claude.json");
  try {
    if (!fs.existsSync(claudeConfigPath)) return { tier: "pro" };
    const raw = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
    return { tier: raw.hasOpusPlanDefault === true ? "max" : "pro" };
  } catch {
    return { tier: "pro" };
  }
}

export function getCustomerPortalUrl(): string {
  return `${DODO_BASE_URL}/portal`;
}

export function computeChecksum(state: Omit<LicenseState, "checksum">): string {
  const payload = JSON.stringify({
    licenseKey: state.licenseKey,
    instanceId: state.instanceId,
    status: state.status,
    plan: state.plan,
    lastValidatedAt: state.lastValidatedAt,
    lastValidationResult: state.lastValidationResult,
    graceStartedAt: state.graceStartedAt,
    warningsSent: state.warningsSent,
  });
  return crypto.createHmac("sha256", INTEGRITY_KEY).update(payload).digest("hex");
}

function computeLegacyChecksum(state: Omit<LicenseState, "checksum">): string {
  const payload = JSON.stringify({
    licenseKey: state.licenseKey,
    instanceId: state.instanceId,
    status: state.status,
    lastValidatedAt: state.lastValidatedAt,
    lastValidationResult: state.lastValidationResult,
    graceStartedAt: state.graceStartedAt,
    warningsSent: state.warningsSent,
  });
  return crypto.createHmac("sha256", INTEGRITY_KEY).update(payload).digest("hex");
}

export function generateInstanceName(ownerId?: number): string {
  const raw = `${os.hostname()}|${os.platform()}|${os.arch()}|${ownerId ?? ""}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// --- State I/O ---

export function defaultLicenseState(): LicenseState {
  const state: Omit<LicenseState, "checksum"> = {
    licenseKey: null,
    instanceId: null,
    status: "expired",
    plan: "pro",
    lastValidatedAt: null,
    lastValidationResult: false,
    graceStartedAt: null,
    warningsSent: 0,
  };
  return { ...state, checksum: computeChecksum(state) };
}

export function loadLicense(): LicenseState {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return defaultLicenseState();
    const raw = JSON.parse(fs.readFileSync(LICENSE_FILE, "utf-8"));

    // Migration: old license files lack `plan` field
    if (!raw.plan) raw.plan = "pro";

    const { checksum, ...rest } = raw as LicenseState;

    // Try new checksum format (with plan)
    const expected = computeChecksum(rest);
    if (checksum === expected) return raw as LicenseState;

    // Try legacy checksum format (without plan) for migration
    const legacyExpected = computeLegacyChecksum(rest);
    if (checksum === legacyExpected) {
      // Valid legacy format — re-save with plan field and new checksum
      const migrated: LicenseState = { ...rest, checksum: computeChecksum(rest) };
      saveLicense(migrated);
      return migrated;
    }

    // Tampered
    const expired = defaultLicenseState();
    expired.status = "expired";
    saveLicense(expired);
    return expired;
  } catch {
    return defaultLicenseState();
  }
}

export function saveLicense(state: LicenseState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  // Recompute checksum before saving
  const { checksum: _, ...rest } = state;
  const fresh: LicenseState = { ...rest, checksum: computeChecksum(rest) };
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  // Keep cache in sync after direct disk write
  _cache = fresh;
}

// --- In-Memory Cache ---
// Avoids synchronous disk I/O on every query. Loaded once, updated in-memory,
// flushed to disk with a debounced timer.

let _cache: LicenseState | null = null;
let _flushTimer: NodeJS.Timeout | null = null;
let _dirty = false;

function getCachedLicense(): LicenseState {
  if (!_cache) {
    _cache = loadLicense();
  }
  return _cache;
}

function markDirty(): void {
  _dirty = true;
  if (_flushTimer) return; // already scheduled
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (_dirty && _cache) {
      _dirty = false;
      saveLicense(_cache);
    }
  }, FLUSH_DEBOUNCE_MS);
}

/** Flush any pending cache writes to disk immediately (call on shutdown). */
export function flushLicenseSync(): void {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (_dirty && _cache) {
    _dirty = false;
    saveLicense(_cache);
  }
}

/** Discard cache so next read comes from disk. */
export function invalidateCache(): void {
  _cache = null;
}

// --- Dodo API ---

export async function activateLicense(
  key: string,
  ownerId?: number,
  plan?: PlanTier
): Promise<{ success: boolean; instanceId?: string; error?: string }> {
  const detectedPlan = plan ?? detectClaudePlan().tier;
  const instanceName = generateInstanceName(ownerId);
  try {
    const res = await fetch(`${DODO_BASE_URL}/licenses/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: key, name: instanceName }),
    });

    if (res.status === 200 || res.status === 201) {
      const data = (await res.json()) as { id: string };
      const state = loadLicense();
      state.licenseKey = key;
      state.instanceId = data.id;
      state.status = "active";
      state.plan = detectedPlan;
      state.lastValidatedAt = new Date().toISOString();
      state.lastValidationResult = true;
      state.graceStartedAt = null;
      state.warningsSent = 0;
      saveLicense(state); // immediate disk write
      invalidateCache();
      return { success: true, instanceId: data.id };
    }

    const body = await res.text();
    if (res.status === 404) return { success: false, error: "License key not found." };
    if (res.status === 403) return { success: false, error: "License key is disabled or expired." };
    if (res.status === 422) return { success: false, error: "Activation limit reached. Deactivate another device first." };
    return { success: false, error: `Activation failed (${res.status}): ${body}` };
  } catch (err) {
    return { success: false, error: `Network error: ${(err as Error).message}` };
  }
}

export async function validateLicense(
  state: LicenseState
): Promise<"valid" | "invalid" | "error"> {
  if (!state.licenseKey || !state.instanceId) return "invalid";
  try {
    const res = await fetch(`${DODO_BASE_URL}/licenses/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: state.licenseKey,
        license_key_instance_id: state.instanceId,
      }),
    });

    if (res.status === 200) return "valid";
    if (res.status === 404 || res.status === 403 || res.status === 422) return "invalid";
    return "error";
  } catch {
    return "error"; // Network failure — no state change
  }
}

export async function deactivateLicense(
  state: LicenseState
): Promise<{ success: boolean; error?: string }> {
  if (!state.licenseKey || !state.instanceId) {
    return { success: false, error: "No active license to deactivate." };
  }
  try {
    const res = await fetch(`${DODO_BASE_URL}/licenses/deactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: state.licenseKey,
        license_key_instance_id: state.instanceId,
      }),
    });

    if (res.status === 200) {
      state.licenseKey = null;
      state.instanceId = null;
      state.status = "expired";
      state.lastValidationResult = false;
      saveLicense(state); // immediate disk write
      invalidateCache();
      return { success: true };
    }

    const body = await res.text();
    return { success: false, error: `Deactivation failed (${res.status}): ${body}` };
  } catch (err) {
    return { success: false, error: `Network error: ${(err as Error).message}` };
  }
}

// --- Startup Check ---

export async function checkLicenseForStartup(): Promise<LicenseCheckResult> {
  // Always read fresh from disk at startup
  invalidateCache();
  const state = getCachedLicense();

  // Expired — blocked
  if (state.status === "expired") {
    return { allowed: false, reason: "License expired." };
  }

  // Active or grace — attempt remote validation
  if (state.status === "active" || state.status === "grace") {
    const result = await validateLicense(state);

    if (result === "valid") {
      state.status = "active";
      state.lastValidatedAt = new Date().toISOString();
      state.lastValidationResult = true;
      state.graceStartedAt = null;
      state.warningsSent = 0;
      saveLicense(state);
      return { allowed: true };
    }

    if (result === "invalid") {
      if (state.status === "active") {
        state.status = "grace";
        state.graceStartedAt = new Date().toISOString();
        state.warningsSent = 0;
        saveLicense(state);
        return {
          allowed: true,
          warning: `Your subscription has lapsed. You have 48 hours to renew.\nRenew: ${getPaymentUrl(state.plan)}`,
        };
      }
      // Already in grace — check if grace expired
      if (state.graceStartedAt) {
        const graceElapsed = Date.now() - new Date(state.graceStartedAt).getTime();
        if (graceElapsed >= GRACE_PERIOD_MS) {
          state.status = "expired";
          saveLicense(state);
          return { allowed: false, reason: "Grace period expired. License required." };
        }
      }
      return { allowed: true, warning: `Subscription lapsed. Renew soon: ${getPaymentUrl(state.plan)}` };
    }

    // result === "error" — network failure, fall back to cached validation
    if (state.lastValidatedAt && state.lastValidationResult) {
      const elapsed = Date.now() - new Date(state.lastValidatedAt).getTime();
      if (elapsed < OFFLINE_GRACE_HOURS * 60 * 60 * 1000) {
        return { allowed: true };
      }
      // Offline too long — enter grace
      if (state.status === "active") {
        state.status = "grace";
        state.graceStartedAt = new Date().toISOString();
        saveLicense(state);
        return {
          allowed: true,
          warning: `Offline too long. Please reconnect within 48 hours.`,
        };
      }
      // Already in grace
      if (state.graceStartedAt) {
        const graceElapsed = Date.now() - new Date(state.graceStartedAt).getTime();
        if (graceElapsed >= GRACE_PERIOD_MS) {
          state.status = "expired";
          saveLicense(state);
          return { allowed: false, reason: "Grace period expired. License required." };
        }
      }
      return { allowed: true };
    }

    // No cached validation at all
    return { allowed: false, reason: "Unable to validate license. Check your network." };
  }

  return { allowed: false, reason: "Unknown license state." };
}

// --- Per-Query Check (Fast, In-Memory) ---

export function checkLicenseForQuery(): LicenseCheckResult {
  const state = getCachedLicense();

  if (state.status === "active") {
    return { allowed: true };
  }

  if (state.status === "grace") {
    if (!state.graceStartedAt) {
      return { allowed: true };
    }
    const graceElapsed = Date.now() - new Date(state.graceStartedAt).getTime();
    if (graceElapsed >= GRACE_PERIOD_MS) {
      state.status = "expired";
      markDirty();
      return { allowed: false, reason: `License expired.\n\nRenew: ${getPaymentUrl(state.plan)}` };
    }

    const hoursRemaining = Math.ceil((GRACE_PERIOD_MS - graceElapsed) / (60 * 60 * 1000));
    return {
      allowed: true,
      warning: `Your subscription has lapsed. ${hoursRemaining}h remaining to renew.\nRenew: ${getPaymentUrl(state.plan)}`,
    };
  }

  // expired
  return { allowed: false, reason: `License expired.\n\nGet a license: ${getPaymentUrl(state.plan)}` };
}

// --- Periodic Validation ---

export function startPeriodicValidation(): NodeJS.Timeout {
  return setInterval(async () => {
    const state = getCachedLicense();
    if (state.status !== "active" && state.status !== "grace") return;

    const result = await validateLicense(state);

    if (result === "valid") {
      if (state.status === "grace") {
        state.status = "active";
        state.graceStartedAt = null;
        state.warningsSent = 0;
      }
      state.lastValidatedAt = new Date().toISOString();
      state.lastValidationResult = true;
      saveLicense(state); // important state change — write immediately
    } else if (result === "invalid") {
      if (state.status === "active") {
        state.status = "grace";
        state.graceStartedAt = new Date().toISOString();
        state.warningsSent = 0;
      }
      state.lastValidationResult = false;
      saveLicense(state); // important state change — write immediately
    }
    // result === "error" — network failure, no state change
  }, VALIDATION_INTERVAL_MS);
}

// --- License Info Display ---

export function getLicenseInfo(): string {
  const state = getCachedLicense();

  if (state.status === "active") {
    const lastValidated = state.lastValidatedAt
      ? new Date(state.lastValidatedAt).toLocaleString()
      : "never";
    return `Status: Active\nPlan: ${getPlanLabel(state.plan)}\nLicense: ${state.licenseKey?.slice(0, 8)}...\nLast validated: ${lastValidated}`;
  }

  if (state.status === "grace") {
    let hoursLeft = "unknown";
    if (state.graceStartedAt) {
      const elapsed = Date.now() - new Date(state.graceStartedAt).getTime();
      hoursLeft = String(Math.max(0, Math.ceil((GRACE_PERIOD_MS - elapsed) / (60 * 60 * 1000))));
    }
    return `Status: Grace period (${hoursLeft}h remaining)\nPlan: ${getPlanLabel(state.plan)}\nYour subscription has lapsed. Renew to continue.\n\nRenew: ${getPaymentUrl(state.plan)}`;
  }

  return `Status: Expired\n\nGet a license: ${getPaymentUrl()}`;
}
