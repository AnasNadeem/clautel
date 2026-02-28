# Clautel

Use [Claude Code](https://github.com/anthropics/claude-code) from your phone via Telegram.

Run one lightweight process on your dev machine. It connects to Telegram via long polling — no server, no public URL, no ngrok. You get a **manager bot** to add/remove project bots, and a **worker bot** per project that gives you full Claude Code access on mobile.

## Install

```bash
npm install -g clautel
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
| `/session` | Get session ID to continue in CLI |
| `/resume` | Resume a CLI session in Telegram |
| `/new` | Start a fresh session |
| `/cancel` | Abort current operation |
| `/feedback` | Send feedback or report an issue |

### Browser Preview

Preview and interact with web pages directly from Telegram — works with `localhost`, staging URLs, or any site.

| Command | Description |
|---|---|
| `/preview <url>` | Open a URL and see a live screenshot |
| `/click <x> <y>` | Click at coordinates on the page |
| `/scroll <up\|down> [amount]` | Scroll the page |
| `/type <text>` | Type into the focused input |
| `/navigate <url>` | Go to a different URL |
| `/browser` | Show current page with controls |

Screenshots update in-place with interactive controls: scroll up/down, back/forward, refresh, and close.

### Session Continuity

Switch seamlessly between CLI and Telegram:

```bash
# Start in CLI, continue on Telegram
claude                        # work on your laptop
# then in Telegram: /resume   # pick it up on your phone

# Start on Telegram, continue in CLI
# in Telegram: /session       # get the session ID
claude --resume <session-id>  # continue in your terminal
```

Conversation history is shown when resuming, so you can pick up where you left off.

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

## Updating

```bash
npm install -g clautel@latest
clautel stop && clautel start
```

## Requirements

- Node.js >= 18
- [Claude Code](https://github.com/anthropics/claude-code) installed and authenticated on the machine running the daemon

## License

MIT
