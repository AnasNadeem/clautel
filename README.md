# claude-on-phone

Use [Claude Code](https://github.com/anthropics/claude-code) from your phone via Telegram.

Run one lightweight process on your dev machine. It connects to Telegram via long polling — no server, no public URL, no ngrok. You get a **manager bot** to add/remove project bots, and a **worker bot** per project that gives you full Claude Code access on mobile.

## Install

```bash
npm install -g claude-on-phone
```

Or via curl:

```bash
curl -fsSL https://raw.githubusercontent.com/AnasNadeem/claude-on-phone/main/install.sh | sh
```

## Setup

**1. Create a manager bot** — go to [@BotFather](https://t.me/botfather) → `/newbot` → copy the token.

**2. Get your Telegram user ID** — message [@userinfobot](https://t.me/userinfobot) → copy the number.

**3. Configure and start:**

```bash
claude-on-phone setup
claude-on-phone start
```

## Usage

DM your manager bot to manage project bots:

| Command | Description |
|---|---|
| `/add TOKEN /path/to/repo` | Attach a new worker bot to a project |
| `/bots` | List active bots |
| `/remove @botname` | Stop and remove a bot |
| `/subscribe` | Get a license or upgrade |
| `/subscription` | View license, billing & cancel |
| `/feedback` | Send feedback or report an issue |
| `/cancel` | Cancel current operation |

Then DM each worker bot directly to use Claude Code:

| Command | Description |
|---|---|
| Send any message | Talk to Claude Code |
| Send a photo/document | Include as context |
| `/model` | Switch model (Opus / Sonnet / Haiku) |
| `/cost` | Show token usage for the session |
| `/session` | Get session ID to resume in CLI |
| `/new` | Start a fresh session |
| `/cancel` | Abort current operation |
| `/feedback` | Send feedback or report an issue |

## CLI

```bash
claude-on-phone setup              # configure token, user ID, and license
claude-on-phone start              # start daemon in background
claude-on-phone stop               # stop daemon
claude-on-phone status             # check if running
claude-on-phone logs               # tail logs (Ctrl+C to exit)
claude-on-phone activate <key>     # activate a license key
claude-on-phone deactivate         # free this machine's activation slot
claude-on-phone license            # show current license status
claude-on-phone install-service    # install as macOS launchd service
claude-on-phone uninstall-service  # remove the launchd service
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Your Machine                                            │
│                                                          │
│  ┌─────────┐    ┌─────────────┐    ┌──────────────────┐ │
│  │ Manager │    │ Worker Bot  │    │ Worker Bot       │ │
│  │   Bot   │    │ (project A) │    │ (project B)      │ │
│  └────┬────┘    └──────┬──────┘    └────────┬─────────┘ │
│       │               │                    │           │
│       └───────┬───────┴────────────────────┘           │
│               │                                         │
│        ┌──────┴──────┐                                  │
│        │   Daemon    │                                  │
│        │ (daemon.ts) │                                  │
│        └──────┬──────┘                                  │
│               │                                         │
│        ┌──────┴──────┐    ┌──────────────────┐         │
│        │ Claude Code │    │   License Gate   │         │
│        │  (claude.ts)│    │  (license.ts)    │         │
│        └─────────────┘    └────────┬─────────┘         │
└────────────────────────────────────┼────────────────────┘
                                     │
                          ┌──────────┴──────────┐
                          │  License Proxy      │
                          │  (Cloudflare Worker) │
                          └──────────┬──────────┘
                                     │
                          ┌──────────┴──────────┐
                          │  DodoPayments API   │
                          └─────────────────────┘
```

## Security

License validation uses a layered defense:

**Client-side:**
- Per-installation random HMAC key (`~/.claude-on-phone/.integrity-key`) — prevents license.json forgery across machines
- Cross-module integrity canaries — daemon, worker, and claude modules verify the license module hasn't been patched at load time
- Runtime function hash verification — daemon periodically checks that `checkLicenseForQuery` hasn't been hot-patched
- Three-gate license checks — startup gate (daemon.ts), per-query gate (worker.ts), and secondary gate (claude.ts)
- Strict response validation — HTTP 200 responses are verified to contain expected fields, preventing empty-response bypass

**Server-side (Cloudflare Worker proxy):**
- Client never talks to the payment API directly — all validation goes through the proxy
- Proxy returns Ed25519-signed tokens — the client can verify signatures (public key embedded) but cannot forge them (private key stays on Cloudflare)
- Signed tokens have 1-hour expiry with 24-hour offline cache
- Cryptographic verification on every validation and activation

See [PAYMENT.md](PAYMENT.md) for full licensing details.

## Requirements

- Node.js >= 18
- [Claude Code](https://github.com/anthropics/claude-code) installed and authenticated on the machine running the daemon

## License

MIT
