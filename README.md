# Clautel

Use [Claude Code](https://github.com/anthropics/claude-code) from your phone via Telegram.

Run one lightweight process on your dev machine. It connects to Telegram via long polling — no server, no public URL, no ngrok. You get a **manager bot** to add/remove project bots, and a **worker bot** per project that gives you full Claude Code access on mobile.

## Install

```bash
npm install -g clautel
```

Or via curl:

```bash
curl -fsSL https://raw.githubusercontent.com/AnasNadeem/clautel/main/install.sh | sh
```

## Setup

**1. Create a manager bot** — go to [@BotFather](https://t.me/botfather) → `/newbot` → copy the token.

**2. Get your Telegram user ID** — message [@userinfobot](https://t.me/userinfobot) → copy the number.

**3. Configure and start:**

```bash
clautel setup
clautel start
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
clautel setup              # configure token, user ID, and license
clautel start              # start daemon in background
clautel stop               # stop daemon
clautel status             # check if running
clautel logs               # tail logs (Ctrl+C to exit)
clautel activate <key>     # activate a license key
clautel deactivate         # free this machine's activation slot
clautel license            # show current license status
clautel install-service    # install as macOS launchd service
clautel uninstall-service  # remove the launchd service
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
                          │  license.clautel.com │
                          └──────────┬──────────┘
                                     │
                          ┌──────────┴──────────┐
                          │  DodoPayments API   │
                          └─────────────────────┘
```

## Security

License validation uses a layered defense:

**Client-side:**
- Per-installation random HMAC key (`~/.clautel/.integrity-key`) — prevents license.json forgery across machines
- Cross-module integrity canaries — daemon, worker, and claude modules verify the license module hasn't been patched at load time
- Runtime function hash verification — daemon periodically checks that `checkLicenseForQuery` hasn't been hot-patched
- Three-gate license checks — startup gate (daemon.ts), per-query gate (worker.ts), and secondary gate (claude.ts)
- Strict response validation — HTTP 200 responses are verified to contain expected fields, preventing empty-response bypass

**Server-side (Cloudflare Worker proxy at `license.clautel.com`):**
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
