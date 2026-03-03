# Contributing to Clautel

Thanks for your interest in contributing!

## Dev Setup

```bash
git clone https://github.com/AnasNadeem/clautel.git
cd clautel
npm install
npm run build
npm test
```

## Running Locally

```bash
# Run daemon directly (no build step, uses tsx)
npm start

# Watch mode (auto-restart on file changes)
npm run dev

# Run CLI commands during development
npx tsx src/cli.ts setup
npx tsx src/cli.ts start
```

## Project Structure

| Path | Description |
|---|---|
| `src/daemon.ts` | Main process — starts manager bot, restores workers, health checks |
| `src/manager.ts` | Manager bot — `/add`, `/remove`, `/bots` commands |
| `src/worker.ts` | Worker bot — handles user messages, photos, documents, tool approvals |
| `src/claude.ts` | Claude bridge — wraps the Claude Agent SDK `query()` call |
| `src/license.ts` | License validation — HMAC checksums, Ed25519 signed tokens, grace logic |
| `src/config.ts` | Config loader — reads env vars and `~/.clautel/config.json` |
| `src/store.ts` | Bot persistence — saves/loads worker bot configs to `bots.json` |
| `src/formatter.ts` | Markdown-to-Telegram HTML converter and message splitter |
| `src/tunnel.ts` | ngrok tunnel manager for live preview |
| `src/log.ts` | Structured logging helpers |
| `proxy/` | Cloudflare Worker — license validation proxy (Ed25519 signing) |
| `tests/` | Test suite (Node.js built-in test runner) |

## Code Style

- TypeScript, strict mode
- No linter configured yet — match surrounding code style
- Prefer explicit types for function signatures, infer for locals
- Use `node:` prefix for built-in imports (`node:fs`, `node:path`, etc.)

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Run `npm run build` — must compile cleanly
4. Run `npm test` — all tests must pass
5. Open a PR using the pull request template

## Tests

```bash
npm test                    # run all tests
node --import tsx --test tests/license.test.ts  # run a single test file
```

Tests use Node.js built-in `node:test` runner with `node:assert`. No external test framework needed.

## Proxy Development

```bash
node scripts/keygen.mjs     # generate Ed25519 keypair for local testing
npm run proxy:dev           # run Cloudflare Worker locally via wrangler
npm run proxy:deploy        # deploy to Cloudflare
```
