# Payment & Licensing

claude-on-phone uses [DodoPayments](https://dodopayments.com) for license key management. No backend server required — all validation uses Dodo's public license endpoints.

## How It Works

```
User discovers checkout via:
  • claude-on-phone setup (terminal prompt)
  • /subscribe command in manager bot
  • Trial warning messages in Telegram
        ↓
Purchase on Dodo checkout page → license key delivered via email
        ↓
claude-on-phone activate <key> → activates on Dodo (tied to machine)
        ↓
Daemon validates on startup + every 4 hours
Every query checks license state locally
        ↓
Manage billing/cancel via:
  • /subscription command in manager bot → links to Dodo customer portal
```

## Setup (Dodo Dashboard)

1. Create a subscription product "claude-on-phone" (monthly/annual)
2. Enable license key delivery: `activation_limit=3`, expiry tied to subscription
3. Create a payment link — update `PAYMENT_URL` in `src/license.ts`
4. Set up the customer portal — update `CUSTOMER_PORTAL_URL` in `src/license.ts`
5. Configure license key delivery via email after payment

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DODO_ENV` | No | `live` | Set to `test` to use `test.dodopayments.com` instead of `live.dodopayments.com` |

No API keys needed — Dodo's `/licenses/activate`, `/licenses/validate`, and `/licenses/deactivate` endpoints are public.

## CLI Commands

```bash
claude-on-phone activate <key>   # Activate a license key on this machine
claude-on-phone deactivate       # Free this machine's activation slot
claude-on-phone license          # Show current license status
```

During `claude-on-phone setup`, users are prompted for a license key. Pressing Enter starts a free trial.

## Manager Bot Commands

| Command | Description |
|---------|-------------|
| `/subscribe` | Shows checkout link to purchase or upgrade |
| `/subscription` | Shows current license status + link to Dodo customer portal (payment history, invoices, cancellation) |

## Free Trial

- **Duration**: 7 days
- **Query limit**: 50 queries
- **Warnings**: Shown at 50%, 80%, 95% usage and when 2 days remain
- **Persists across reinstall**: Trial state lives in `~/.claude-on-phone/license.json`

## License Lifecycle

```
trial → (activate) → active → (subscription lapses) → grace (48h) → expired
                         ↑          ↓ (renews)
                         └──────────┘
```

## Offline Tolerance

| Scenario | Behavior |
|----------|----------|
| Startup validation fails (network) | Allowed if last validated within 72h |
| Periodic validation fails (network) | No state change, keeps current status |
| Offline > 72h (last validation was valid) | Enters 48h grace period |
| **Total offline tolerance** | **120h (5 days)** before hard stop |

## Security Layers

| Layer | Description |
|-------|-------------|
| HMAC-signed `license.json` | Editing trial counters/dates invalidates checksum |
| Startup validation | Daemon won't start without valid license/trial |
| Per-query gate (`worker.ts`) | Every Telegram message checked |
| Secondary gate (`claude.ts`) | Backup check before Claude API call |
| Server-side activation limit | Dodo enforces max 3 devices per key |
| Trial tied to owner ID | Changing owner breaks checksum + loses bots |

## Files

| File | Purpose |
|------|---------|
| `src/license.ts` | Core module: state I/O, Dodo API, trial/grace logic, HMAC |
| `tests/license.test.ts` | 34 test cases covering all state transitions |
| `~/.claude-on-phone/license.json` | Runtime license state (mode `0600`) |

## Testing

```bash
# Run with test Dodo environment
DODO_ENV=test claude-on-phone setup
DODO_ENV=test claude-on-phone activate <test-key>

# Run tests
npm test
```
