#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(os.homedir(), ".claude-on-phone");
const PID_FILE = path.join(DATA_DIR, "daemon.pid");
const LOG_FILE = path.join(DATA_DIR, "app.log");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// Resolve daemon path: prefer compiled dist/daemon.js, fall back to tsx for local dev
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compiledDaemon = path.join(__dirname, "daemon.js");
const srcDaemon = path.join(__dirname, "../src/daemon.ts");

const DAEMON_CMD: [string, string[]] = fs.existsSync(compiledDaemon)
  ? [process.execPath, [compiledDaemon]]
  : ["npx", ["tsx", srcDaemon]];

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function cmdSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log("Claude on Phone — Setup\n");
  console.log("You'll need:");
  console.log("  • A bot token from @BotFather (this will be your manager bot)");
  console.log("  • Your Telegram user ID (get it from @userinfobot)\n");

  const token = (await ask("Manager bot token: ")).trim();
  const ownerIdStr = (await ask("Your Telegram user ID: ")).trim();
  rl.close();

  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    console.error("Invalid bot token format.");
    process.exit(1);
  }

  const ownerId = parseInt(ownerIdStr, 10);
  if (isNaN(ownerId)) {
    console.error("Invalid user ID — must be a number.");
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_OWNER_ID: ownerId }, null, 2),
    { mode: 0o600 }
  );

  console.log(`\nConfig saved to ${CONFIG_FILE}`);
  console.log("Run: claude-on-phone start");
}

function cmdStart(): void {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(`Already running (PID ${pid})`);
    return;
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("Not configured. Run: claude-on-phone setup");
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const logFd = fs.openSync(LOG_FILE, "a");

  const [cmd, args] = DAEMON_CMD;
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));

  console.log(`Started (PID ${child.pid})`);
  console.log(`Logs: claude-on-phone logs`);
}

function cmdStop(): void {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log("Not running.");
    fs.rmSync(PID_FILE, { force: true });
    return;
  }

  process.kill(pid, "SIGTERM");
  fs.rmSync(PID_FILE, { force: true });
  console.log(`Stopped (PID ${pid})`);
}

function cmdStatus(): void {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log("Status: stopped");
    return;
  }
  console.log(`Status: running (PID ${pid})`);
  console.log(`Logs: ${LOG_FILE}`);
}

function cmdLogs(): void {
  if (!fs.existsSync(LOG_FILE)) {
    console.log("No log file yet. Start the daemon first.");
    return;
  }

  const tail = spawn("tail", ["-n", "50", "-f", LOG_FILE], { stdio: "inherit" });

  process.on("SIGINT", () => {
    tail.kill();
    process.exit(0);
  });
}

function cmdHelp(): void {
  console.log(`
Claude on Phone — Telegram bridge for Claude Code

Usage: claude-on-phone <command>

Commands:
  setup    Configure your bot token and Telegram user ID
  start    Start the daemon in the background
  stop     Stop the daemon
  status   Show whether the daemon is running
  logs     Tail the daemon logs (Ctrl+C to exit)
  help     Show this help message

Getting started:
  1. claude-on-phone setup
  2. claude-on-phone start
  3. DM your manager bot on Telegram
  4. Use /add to attach a bot to a project directory
`);
}

const command = process.argv[2] ?? "help";

switch (command) {
  case "setup":
    cmdSetup().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "start":
    cmdStart();
    break;
  case "stop":
    cmdStop();
    break;
  case "status":
    cmdStatus();
    break;
  case "logs":
    cmdLogs();
    break;
  default:
    cmdHelp();
}
