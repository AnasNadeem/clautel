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
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const LOG_KEEP_COUNT = 3; // keep app.log.1, app.log.2, app.log.3

const LAUNCHD_LABEL = "com.claude-on-phone.daemon";

// Resolve daemon path: prefer compiled dist/daemon.js, fall back to tsx for local dev
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compiledDaemon = path.join(__dirname, "daemon.js");
const srcDaemon = path.join(__dirname, "../src/daemon.ts");

const DAEMON_CMD: [string, string[]] = fs.existsSync(compiledDaemon)
  ? [process.execPath, [compiledDaemon]]
  : ["npx", ["tsx", srcDaemon]];

function rotateLog(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < LOG_MAX_BYTES) return;

    // Shift existing rotated logs: app.log.2 → app.log.3, app.log.1 → app.log.2, etc.
    for (let i = LOG_KEEP_COUNT - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    // Current log becomes app.log.1
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {}
}

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
  const licenseKeyInput = (await ask("License key (Enter for 7-day free trial): ")).trim();
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

  // Handle license activation or trial
  if (licenseKeyInput) {
    const { activateLicense } = await import("./license.js");
    console.log("\nActivating license...");
    const result = await activateLicense(licenseKeyInput, ownerId);
    if (result.success) {
      console.log("License activated successfully!");
    } else {
      console.error(`License activation failed: ${result.error}`);
      console.log("You can activate later: claude-on-phone activate <key>");
      console.log("Starting with 7-day free trial instead.");
      const { defaultLicenseState: defaultState, saveLicense: saveLic } = await import("./license.js");
      saveLic(defaultState());
    }
  } else {
    // Initialize trial state
    const { defaultLicenseState, saveLicense } = await import("./license.js");
    saveLicense(defaultLicenseState());
    console.log("\nStarting 7-day free trial (50 queries).");
    console.log("Activate anytime: claude-on-phone activate <key>");
  }

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
  rotateLog();

  const logFd = fs.openSync(LOG_FILE, "a");

  const [cmd, args] = DAEMON_CMD;
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  fs.closeSync(logFd);
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

function getPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function cmdInstallService(): void {
  if (process.platform !== "darwin") {
    console.error("install-service is only supported on macOS (launchd).");
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("Not configured. Run: claude-on-phone setup");
    process.exit(1);
  }

  const [cmd, args] = DAEMON_CMD;
  const programArgs = [cmd, ...args];

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${programArgs.map((a) => `<string>${a}</string>`).join("\n    ")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}</string>
  </dict>
</dict>
</plist>`;

  const agentsDir = path.dirname(getPlistPath());
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(getPlistPath(), plist);

  const load = spawn("launchctl", ["load", getPlistPath()], { stdio: "inherit" });
  load.on("close", (code) => {
    if (code === 0) {
      console.log("Service installed and started.");
      console.log(`Plist: ${getPlistPath()}`);
      console.log("The daemon will auto-restart on crash and start at login.");
    } else {
      console.error("Failed to load service. Check: launchctl list | grep claude");
    }
  });
}

function cmdUninstallService(): void {
  if (process.platform !== "darwin") {
    console.error("uninstall-service is only supported on macOS (launchd).");
    process.exit(1);
  }

  if (!fs.existsSync(getPlistPath())) {
    console.log("Service not installed.");
    return;
  }

  const unload = spawn("launchctl", ["unload", getPlistPath()], { stdio: "inherit" });
  unload.on("close", () => {
    fs.rmSync(getPlistPath(), { force: true });
    console.log("Service uninstalled.");
  });
}

async function cmdActivate(): Promise<void> {
  const key = process.argv[3];
  if (!key) {
    console.error("Usage: claude-on-phone activate <license-key>");
    process.exit(1);
  }

  // Load owner ID from config for instance fingerprint
  let ownerId: number | undefined;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      ownerId = cfg.TELEGRAM_OWNER_ID;
    }
  } catch (err) {
    console.warn(`Warning: Could not read config file: ${(err as Error).message}`);
    console.warn("License will be activated without owner ID binding.");
  }

  const { activateLicense } = await import("./license.js");
  console.log("Activating license...");
  const result = await activateLicense(key, ownerId);
  if (result.success) {
    console.log("License activated successfully!");
    console.log("Restart the daemon to apply: claude-on-phone stop && claude-on-phone start");
  } else {
    console.error(`Activation failed: ${result.error}`);
    process.exit(1);
  }
}

async function cmdDeactivate(): Promise<void> {
  const { loadLicense, deactivateLicense } = await import("./license.js");
  const state = loadLicense();

  if (!state.licenseKey) {
    console.log("No active license to deactivate.");
    return;
  }

  console.log("Deactivating license...");
  const result = await deactivateLicense(state);
  if (result.success) {
    console.log("License deactivated. Activation slot freed.");
  } else {
    console.error(`Deactivation failed: ${result.error}`);
    process.exit(1);
  }
}

async function cmdLicense(): Promise<void> {
  const { getLicenseInfo } = await import("./license.js");
  console.log(getLicenseInfo());
}

function cmdHelp(): void {
  console.log(`
Claude on Phone — Telegram bridge for Claude Code

Usage: claude-on-phone <command>

Commands:
  setup              Configure your bot token and Telegram user ID
  start              Start the daemon in the background
  stop               Stop the daemon
  status             Show whether the daemon is running
  logs               Tail the daemon logs (Ctrl+C to exit)
  activate <key>     Activate a license key
  deactivate         Deactivate this machine's license
  license            Show current license status
  install-service    Install as a macOS launchd service (auto-restart)
  uninstall-service  Remove the launchd service
  help               Show this help message

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
  case "activate":
    cmdActivate().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "deactivate":
    cmdDeactivate().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "license":
    cmdLicense().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "install-service":
    cmdInstallService();
    break;
  case "uninstall-service":
    cmdUninstallService();
    break;
  default:
    cmdHelp();
}
