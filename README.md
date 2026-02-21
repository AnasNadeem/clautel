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

## CLI

```bash
claude-on-phone setup    # configure token and user ID
claude-on-phone start    # start daemon in background
claude-on-phone stop     # stop daemon
claude-on-phone status   # check if running
claude-on-phone logs     # tail logs (Ctrl+C to exit)
```

## Requirements

- Node.js >= 18
- [Claude Code](https://github.com/anthropics/claude-code) installed and authenticated on the machine running the daemon

## License

MIT
