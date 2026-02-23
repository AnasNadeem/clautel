# Payment & Licensing

Clautel uses [DodoPayments](https://dodopayments.com) for license key management. License validation goes through a Cloudflare Worker proxy at `license.clautel.com` that signs responses with Ed25519 — the client can verify but not forge tokens.

## How It Works

```
User discovers checkout via:
  • clautel setup (terminal prompt)
  • /subscribe command in manager bot
  • License expired messages in Telegram
        ↓
Purchase on Dodo checkout page → license key delivered via email
        ↓
clautel activate <key> → proxy forwards to Dodo, returns signed token
        ↓
Daemon validates on startup + every 1 hour via proxy
Every query checks license state locally (in-memory cache)
        ↓
Manage billing/cancel via:
  • /subscription command in manager bot → links to Dodo customer portal
```

## Validation Flow

```
Client                          Proxy (license.clautel.com)    DodoPayments
  │                                  │                            │
  │── POST /validate {key, id} ────→ │                            │
  │                                  │── POST /licenses/validate →│
  │                                  │←── { id: "..." } ─────────│
  │                                  │                            │
  │                                  │ Sign token with Ed25519    │
  │                                  │ private key (1h expiry)    │
  │←── { token, signature } ────────│                            │
  │                                                               │
  │ Verify Ed25519 signature                                      │
  │ Check token.expiresAt > now                                   │
  │ Check token.licenseKey matches                                │
  │ Cache token for offline fallback                              │
```

## Plans

| Plan | Price | When Required |
|------|-------|---------------|
| Pro | $4/mo | Claude Pro users (Sonnet default) |
| Max | $9/mo | Claude Max users (Opus default) |

Plan detection is automatic — Clautel reads `~/.claude.json` to detect whether you're on Claude Pro or Max. If you upgrade your Claude plan, you'll be prompted to upgrade your license.

## Setup (Dodo Dashboard)

1. Create subscription products for Pro and Max tiers
2. Enable license key delivery: `activation_limit=3`, expiry tied to subscription
3. Update `PAYMENT_PRODUCTS` in `src/license.ts` with product IDs
4. Configure license key delivery via email after payment

## Proxy Setup (Cloudflare Worker)

The proxy at `license.clautel.com` prevents clients from talking to Dodo directly and signs all responses with Ed25519.

```bash
# 1. Deploy proxy
cd proxy && npm install && npx wrangler deploy

# 2. Store private key as Cloudflare secret
cd proxy && npx wrangler secret put ED25519_PRIVATE_KEY_HEX

# 3. Rebuild client
npm run build
```

The Ed25519 public key and proxy URL (`https://license.clautel.com`) are already embedded in `src/license.ts`.

## CLI Commands

```bash
clautel activate <key>     # Activate a license key on this machine
clautel deactivate         # Free this machine's activation slot
clautel license            # Show current license status
```

During `clautel setup`, users are prompted for a license key.

## Manager Bot Commands

| Command | Description |
|---------|-------------|
| `/subscribe` | Shows checkout link to purchase or upgrade |
| `/subscription` | Shows current license status + link to Dodo customer portal |

## License Lifecycle

```
active ──(subscription lapses)──→ grace (1h) ──→ expired
  ↑               ↓ (renews)
  └───────────────┘
```

## Offline Tolerance

| Scenario | Behavior |
|----------|----------|
| Startup validation fails (network) | Allowed if last validated within 24h |
| Periodic validation fails (network) | No state change, keeps current status |
| Proxy configured + network failure | Falls back to cached Ed25519 signed token (max 24h) |
| Offline > 24h (last validation was valid) | Enters 1h grace period |
| **Total offline tolerance** | **25h** before hard stop |

## Security Layers

### Client-Side

| Layer | Description |
|-------|-------------|
| Per-installation HMAC key | Random 64-byte key generated on first run at `~/.clautel/.integrity-key` (mode `0600`). Each machine has a unique key — forging a checksum requires the key file from that specific installation. |
| Integrity canaries | `license.ts` exports `LICENSE_CANARY`. `daemon.ts`, `worker.ts`, and `claude.ts` verify it at module load. Patching `dist/license.js` to skip checks without also patching all three consumers causes an integrity failure. |
| Function hash verification | `daemon.ts` computes SHA-256 of `checkLicenseForQuery.toString()` at startup. The health check (every 60s) recomputes and compares. Hot-patching the function at runtime is detected. |
| Three-gate validation | Startup gate in `daemon.ts` (async, remote), per-query gate in `worker.ts` (sync, in-memory), secondary gate in `claude.ts` (sync, backup). All three must pass. |
| Strict response validation | HTTP 200 responses must contain expected JSON fields (`body.id` must be a string). Empty 200 from a local proxy is rejected. |
| Immediate expiry persistence | Security-critical state transitions (grace → expired) use `saveLicense()` + `invalidateCache()` instead of debounced writes, preventing process-kill race conditions. |
| Grace period null guard | If `status === "grace"` but `graceStartedAt === null`, the license is immediately expired. Prevents infinite free access via null grace state. |

### Server-Side (Cloudflare Worker Proxy)

| Layer | Description |
|-------|-------------|
| Ed25519 signed tokens | Proxy signs every response with Ed25519 private key (stored as Cloudflare secret). Client verifies with embedded public key. Cannot be forged without the private key. |
| Token expiry | Signed tokens expire after 1 hour. Client must re-validate with the proxy. |
| Offline cache | Valid signed tokens are cached locally for up to 24 hours. Signature is re-verified on every cache read. Future-dated tokens (clock rollback) are rejected. |
| No direct API access | Client calls the proxy, not Dodo. Even if someone discovers the Dodo endpoints, the client requires Ed25519-signed responses to accept validation results. |
| Input validation | Proxy validates all input fields (type and existence) and returns 400 for malformed requests. |

## Files

| File | Purpose |
|------|---------|
| `src/license.ts` | Core module: state I/O, Ed25519 verification, proxy integration, grace logic, HMAC checksums |
| `src/daemon.ts` | Startup license gate, periodic validation, integrity checks |
| `src/worker.ts` | Per-query license gate, canary verification |
| `src/claude.ts` | Secondary license gate, canary verification |
| `proxy/src/worker.ts` | Cloudflare Worker: forwards to Dodo, signs responses with Ed25519 |
| `proxy/wrangler.toml` | Worker configuration |
| `scripts/keygen.mjs` | One-time Ed25519 keypair generator |
| `~/.clautel/license.json` | Runtime license state (mode `0600`) |
| `~/.clautel/.integrity-key` | Per-installation HMAC key (mode `0600`) |
| `~/.clautel/signed-token.json` | Cached Ed25519 signed token for offline fallback (mode `0600`) |
| `tests/license.test.ts` | License module test cases |

## Testing

```bash
# Run license tests
npm test

# Generate a keypair for local proxy testing
node scripts/keygen.mjs

# Run proxy locally
npm run proxy:dev

# Deploy proxy to Cloudflare
npm run proxy:deploy
```
