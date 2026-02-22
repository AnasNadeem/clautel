import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";

// --- Constants ---

const VALIDATION_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour
const OFFLINE_GRACE_HOURS = 24;
const GRACE_PERIOD_MS = 1 * 60 * 60 * 1000; // 1 hour
const DODO_CHECKOUT_URL = "https://checkout.dodopayments.com";
const DODO_BASE_URL = "https://live.dodopayments.com";
const SUCCESS_PAGE_URL = "https://whoareyouanas.com/claude-on-phone/success";

// --- Server-Side Proxy (Ed25519 Signed Tokens) ---
// IMPORTANT: Update PROXY_BASE_URL after deploying the Cloudflare Worker
const PROXY_BASE_URL = "https://claude-on-phone-license.<YOUR-SUBDOMAIN>.workers.dev";
// IMPORTANT: Replace with the public key hex from `node scripts/keygen.mjs`
const ED25519_PUBLIC_KEY_HEX = "0000000000000000000000000000000000000000000000000000000000000000";
const SIGNED_TOKEN_FILE = path.join(DATA_DIR, "signed-token.json");
const TOKEN_OFFLINE_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours

export type PlanTier = "pro" | "max";

const PAYMENT_PRODUCTS: Record<PlanTier, string> = {
  pro: "pdt_0NZ4nZm2ssXq7ZXBkwvcp",
  max: "pdt_0NZ4noNAkdJ9nIDIO8PJa",
};

const PLAN_LABELS: Record<PlanTier, string> = {
  pro: "Pro ($4/mo)",
  max: "Max ($9/mo)",
};

const PLAN_ORDER: Record<PlanTier, number> = { pro: 0, max: 1 };

const LICENSE_FILE = path.join(DATA_DIR, "license.json");
const INTEGRITY_KEY_FILE = path.join(DATA_DIR, ".integrity-key");
const FLUSH_DEBOUNCE_MS = 5000; // 5 seconds

// Per-installation random integrity key (cached in memory after first read)
let _integrityKeyCache: Buffer | null = null;

function getIntegrityKey(): Buffer {
  if (_integrityKeyCache) return _integrityKeyCache;
  try {
    if (fs.existsSync(INTEGRITY_KEY_FILE)) {
      _integrityKeyCache = fs.readFileSync(INTEGRITY_KEY_FILE);
      return _integrityKeyCache;
    }
  } catch {}
  // Generate new per-installation key
  const newKey = crypto.randomBytes(64);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(INTEGRITY_KEY_FILE, newKey, { mode: 0o600 });
  _integrityKeyCache = newKey;
  return newKey;
}

// --- Canary ---
// Cross-module integrity check: other modules verify this value at load/startup
export const LICENSE_CANARY = "L1c3ns3-Ch3ck-V2";

// --- Types ---

interface SignedToken {
  licenseKey: string;
  instanceId: string;
  status: "active" | "invalid";
  issuedAt: number;
  expiresAt: number;
}

interface SignedResponse {
  token: SignedToken;
  signature: string;
}

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
  formatVersion?: number; // undefined = v1 legacy, 2 = server-signed
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

let _claudePlanCache: { tier: PlanTier; timestamp: number } | null = null;
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function detectClaudePlan(): { tier: PlanTier } {
  if (_claudePlanCache && Date.now() - _claudePlanCache.timestamp < PLAN_CACHE_TTL_MS) {
    return { tier: _claudePlanCache.tier };
  }
  const claudeConfigPath = path.join(os.homedir(), ".claude.json");
  let tier: PlanTier = "pro";
  try {
    if (fs.existsSync(claudeConfigPath)) {
      const raw = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
      if (raw.hasOpusPlanDefault === true) tier = "max";
    }
  } catch {}
  _claudePlanCache = { tier, timestamp: Date.now() };
  return { tier };
}

/** Force re-read on next detectClaudePlan() call. */
export function invalidatePlanCache(): void {
  _claudePlanCache = null;
}

/** True when the user's Claude plan is higher than their license plan (must upgrade). */
export function isUnderLicensed(licensePlan: PlanTier, claudePlan: PlanTier): boolean {
  return PLAN_ORDER[claudePlan] > PLAN_ORDER[licensePlan];
}

/** True when the user's Claude plan is lower than their license plan (auto-downgrade). */
export function isOverLicensed(licensePlan: PlanTier, claudePlan: PlanTier): boolean {
  return PLAN_ORDER[claudePlan] < PLAN_ORDER[licensePlan];
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
    formatVersion: state.formatVersion,
  });
  return crypto.createHmac("sha256", getIntegrityKey()).update(payload).digest("hex");
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
    formatVersion: undefined,
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

    const expected = computeChecksum(rest);
    if (checksum === expected) return raw as LicenseState;

    // Checksum mismatch — tampered or corrupted
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

// --- Ed25519 Signed Token Verification ---

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

async function verifySignedToken(response: SignedResponse): Promise<boolean> {
  try {
    const pubKeyDer = Buffer.concat([
      // Ed25519 SPKI prefix (12 bytes)
      Buffer.from([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
        0x70, 0x03, 0x21, 0x00,
      ]),
      hexToBuffer(ED25519_PUBLIC_KEY_HEX),
    ]);
    const publicKey = crypto.createPublicKey({
      key: pubKeyDer,
      format: "der",
      type: "spki",
    });
    const data = Buffer.from(JSON.stringify(response.token));
    const signature = Buffer.from(response.signature, "base64");
    return crypto.verify(null, data, publicKey, signature);
  } catch {
    return false;
  }
}

function cacheSignedToken(response: SignedResponse): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      SIGNED_TOKEN_FILE,
      JSON.stringify(response, null, 2),
      { mode: 0o600 }
    );
  } catch {}
}

function loadCachedSignedToken(): SignedResponse | null {
  try {
    if (!fs.existsSync(SIGNED_TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(SIGNED_TOKEN_FILE, "utf-8")) as SignedResponse;
  } catch {
    return null;
  }
}

function clearSignedTokenCache(): void {
  try {
    if (fs.existsSync(SIGNED_TOKEN_FILE)) {
      fs.unlinkSync(SIGNED_TOKEN_FILE);
    }
  } catch {}
}

async function validateFromCache(state: LicenseState): Promise<"valid" | "invalid" | "error"> {
  const cached = loadCachedSignedToken();
  if (!cached) return "error";

  // Re-verify the cryptographic signature
  const valid = await verifySignedToken(cached);
  if (!valid) return "error";

  // Check token age (max 24h offline)
  const tokenAgeMs = Date.now() - cached.token.issuedAt * 1000;
  if (tokenAgeMs > TOKEN_OFFLINE_MAX_MS) return "error";

  // Check the token belongs to this license
  if (cached.token.licenseKey !== state.licenseKey) return "error";

  return cached.token.status === "active" ? "valid" : "invalid";
}

function isProxyConfigured(): boolean {
  return (
    PROXY_BASE_URL !== "https://claude-on-phone-license.<YOUR-SUBDOMAIN>.workers.dev" &&
    ED25519_PUBLIC_KEY_HEX !== "0000000000000000000000000000000000000000000000000000000000000000"
  );
}

// --- Dodo API ---

export async function activateLicense(
  key: string,
  ownerId?: number,
  plan?: PlanTier
): Promise<{ success: boolean; instanceId?: string; error?: string }> {
  const { tier: claudeTier } = detectClaudePlan();
  const requestedPlan = plan ?? claudeTier;

  // Enforce: can't activate with a plan lower than detected Claude plan
  if (isUnderLicensed(requestedPlan, claudeTier)) {
    return {
      success: false,
      error: `Your Claude plan is ${getPlanLabel(claudeTier)} — you need a ${getPlanLabel(claudeTier)} license.\nGet one at: ${getPaymentUrl(claudeTier)}`,
    };
  }

  const instanceName = generateInstanceName(ownerId);
  try {
    // Use proxy if configured, otherwise fall back to direct Dodo (transition period)
    const useProxy = isProxyConfigured();
    const url = useProxy
      ? `${PROXY_BASE_URL}/activate`
      : `${DODO_BASE_URL}/licenses/activate`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: key, name: instanceName }),
    });

    if (res.status === 200 || res.status === 201) {
      const data = (await res.json()) as { id: string; token?: SignedToken; signature?: string };

      // If proxy returned a signed token, verify and cache it
      if (useProxy && data.token && data.signature) {
        const signedResponse: SignedResponse = { token: data.token, signature: data.signature };
        const verified = await verifySignedToken(signedResponse);
        if (!verified) {
          return { success: false, error: "Server response signature verification failed." };
        }
        cacheSignedToken(signedResponse);
      }

      const state = loadLicense();
      state.licenseKey = key;
      state.instanceId = data.id;
      state.status = "active";
      state.plan = requestedPlan;
      state.lastValidatedAt = new Date().toISOString();
      state.lastValidationResult = true;
      state.graceStartedAt = null;
      state.warningsSent = 0;
      state.formatVersion = useProxy ? 2 : state.formatVersion;
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

  const useProxy = isProxyConfigured();

  try {
    if (useProxy) {
      // Proxy path: Ed25519-signed responses
      const res = await fetch(`${PROXY_BASE_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          license_key: state.licenseKey,
          license_key_instance_id: state.instanceId,
        }),
      });

      let body: SignedResponse;
      try {
        body = (await res.json()) as SignedResponse;
      } catch {
        return "error";
      }

      if (!body.token || !body.signature) return "error";

      // Verify Ed25519 signature
      const verified = await verifySignedToken(body);
      if (!verified) return "error";

      // Check token is not expired
      if (body.token.expiresAt <= Math.floor(Date.now() / 1000)) return "error";

      // Check token belongs to this license
      if (body.token.licenseKey !== state.licenseKey) return "error";

      // Cache the signed token for offline fallback
      cacheSignedToken(body);

      return body.token.status === "active" ? "valid" : "invalid";
    }

    // Direct Dodo path (fallback during transition)
    const res = await fetch(`${DODO_BASE_URL}/licenses/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: state.licenseKey,
        license_key_instance_id: state.instanceId,
      }),
    });

    if (res.status === 200) {
      // Strict body validation — reject empty 200 from local proxies
      try {
        const body = (await res.json()) as Record<string, unknown>;
        if (!body.id || typeof body.id !== "string") return "error";
      } catch {
        return "error";
      }
      return "valid";
    }
    if (res.status === 404 || res.status === 403 || res.status === 422) return "invalid";
    return "error";
  } catch {
    // Network failure — try offline cache if proxy is configured
    if (useProxy) {
      return validateFromCache(state);
    }
    return "error";
  }
}

export async function deactivateLicense(
  state: LicenseState
): Promise<{ success: boolean; error?: string }> {
  if (!state.licenseKey || !state.instanceId) {
    return { success: false, error: "No active license to deactivate." };
  }
  try {
    // Use proxy if configured, otherwise direct Dodo
    const url = isProxyConfigured()
      ? `${PROXY_BASE_URL}/deactivate`
      : `${DODO_BASE_URL}/licenses/deactivate`;

    const res = await fetch(url, {
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
      state.formatVersion = undefined;
      saveLicense(state); // immediate disk write
      invalidateCache();
      clearSignedTokenCache();
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
      // Sync plan with Claude subscription on startup
      const { tier: claudeTier } = detectClaudePlan();
      if (isUnderLicensed(state.plan, claudeTier)) {
        return {
          allowed: false,
          reason: `Your Claude plan upgraded to ${getPlanLabel(claudeTier)}. Please upgrade your license.\n\nPurchase: ${getPaymentUrl(claudeTier)}\nActivate: claude-on-phone activate <key>`,
        };
      }
      if (isOverLicensed(state.plan, claudeTier)) {
        state.plan = claudeTier;
      }

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
          warning: `Your subscription has lapsed. You have 1 hour to renew.\nRenew: ${getPaymentUrl(state.plan)}`,
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
      } else {
        // No grace start time — cannot be in grace, expire immediately
        state.status = "expired";
        saveLicense(state);
        return { allowed: false, reason: "Grace period invalid. License required." };
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
          warning: `Offline too long. Please reconnect within 1 hour.`,
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
      } else {
        // No grace start time — cannot be in grace, expire immediately
        state.status = "expired";
        saveLicense(state);
        return { allowed: false, reason: "Grace period invalid. License required." };
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
    // Plan enforcement: sync license plan with Claude subscription
    const { tier: claudeTier } = detectClaudePlan();
    if (isUnderLicensed(state.plan, claudeTier)) {
      // User upgraded Claude → must upgrade license
      return {
        allowed: false,
        reason: `Your Claude plan upgraded to ${getPlanLabel(claudeTier)}.\nPlease upgrade your license.\n\n${getPaymentUrl(claudeTier)}`,
      };
    }
    if (isOverLicensed(state.plan, claudeTier)) {
      // User downgraded Claude → auto-update license plan
      state.plan = claudeTier;
      markDirty();
    }
    return { allowed: true };
  }

  if (state.status === "grace") {
    if (!state.graceStartedAt) {
      // No grace start time — cannot be in grace, expire immediately
      state.status = "expired";
      saveLicense(state);
      invalidateCache();
      return { allowed: false, reason: `License expired.\n\nRenew: ${getPaymentUrl(state.plan)}` };
    }
    const graceElapsed = Date.now() - new Date(state.graceStartedAt).getTime();
    if (graceElapsed >= GRACE_PERIOD_MS) {
      state.status = "expired";
      saveLicense(state);
      invalidateCache();
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
      // Periodic plan sync: auto-downgrade if user changed Claude plan
      invalidatePlanCache();
      const { tier: claudeTier } = detectClaudePlan();
      if (isOverLicensed(state.plan, claudeTier)) {
        state.plan = claudeTier;
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

  return `Status: Expired\n\nGet a license: ${getPaymentUrl(detectClaudePlan().tier)}`;
}
