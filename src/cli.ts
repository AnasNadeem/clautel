#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(os.homedir(), ".clautel");
const PID_FILE = path.join(DATA_DIR, "daemon.pid");
const LOG_FILE = path.join(DATA_DIR, "app.log");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const LOG_KEEP_COUNT = 3; // keep app.log.1, app.log.2, app.log.3

const LAUNCHD_LABEL = "com.clautel.daemon";

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

  console.log("Clautel — Setup\n");

  // Step 1/4: Bot token with live validation
  console.log("Step 1/4: Manager Bot");
  console.log("  Create a bot via @BotFather on Telegram and paste the token here.");
  console.log("  It looks like: 123456:ABC-DEF...\n");

  let token = "";
  let botUsername = "";
  while (true) {
    token = (await ask("  Bot token: ")).trim();
    if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
      console.log("  Invalid format. Token looks like: 123456:ABC-DEF...\n");
      continue;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = (await res.json()) as { ok: boolean; result?: { username: string } };
      if (!data.ok) {
        console.log("  Token rejected by Telegram. Check it and try again.\n");
        continue;
      }
      botUsername = data.result!.username;
      console.log(`  Connected to @${botUsername}\n`);
      break;
    } catch {
      console.log("  Could not reach Telegram API. Check your connection.\n");
      continue;
    }
  }

  // Step 2/4: Owner Telegram ID
  console.log("Step 2/4: Your Telegram ID");
  console.log("  This ensures only you can use the bot.");
  console.log("  To find your ID:");
  console.log("    1. Open Telegram and search for @userinfobot");
  console.log("    2. Send it any message — it replies with your user ID\n");

  let ownerId = 0;
  while (true) {
    const ownerIdStr = (await ask("  Your Telegram user ID: ")).trim();
    ownerId = parseInt(ownerIdStr, 10);
    if (!ownerIdStr || isNaN(ownerId) || ownerId <= 0) {
      console.log("  Invalid ID — must be a positive number.\n");
      continue;
    }
    console.log(`  Owner set to ${ownerId}\n`);
    break;
  }

  // Step 3: Ngrok Configuration (optional, for live preview)
  console.log("Step 3/4: Ngrok Configuration (for live preview)");
  console.log("  To preview your dev server from your phone, Clautel can create ngrok tunnels.");
  console.log("  Get a free auth token at: https://dashboard.ngrok.com/get-started/your-authtoken");
  console.log("  Press Enter to skip.\n");

  const ngrokToken = (await ask("  Ngrok auth token: ")).trim();
  if (ngrokToken) {
    console.log("  Ngrok token saved.\n");
  } else {
    console.log("  Skipped — you can configure it later via NGROK_AUTH_TOKEN env var or re-run setup.\n");
  }

  // Write config
  const configData: Record<string, unknown> = { TELEGRAM_BOT_TOKEN: token, TELEGRAM_OWNER_ID: ownerId };
  if (ngrokToken) configData.NGROK_AUTH_TOKEN = ngrokToken;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(configData, null, 2),
    { mode: 0o600 }
  );

  // Step 4/4: License
  const { getPaymentUrl, activateLicense, getPlanLabel, saveClaudePlan } = await import("./license.js");

  console.log("Step 4/4: License\n");
  console.log("  Choose your plan:\n");
  console.log("    [1] Pro — $4/mo");
  console.log("        Up to 5 project bots\n");
  console.log("    [2] Max — $9/mo (Recommended)");
  console.log("        Unlimited project bots\n");

  let tier: "pro" | "max" = "max";
  while (true) {
    const choice = (await ask("  Select plan (1 or 2): ")).trim();
    if (choice === "1") { tier = "pro"; break; }
    if (choice === "2" || choice === "") { tier = "max"; break; }
    console.log("  Please enter 1 or 2.\n");
  }
  saveClaudePlan(tier);

  const planLabel = getPlanLabel(tier);
  console.log(`\n  Selected: ${planLabel}`);
  console.log(`  Get a license at: ${getPaymentUrl(tier)}`);
  console.log("  Paste your license key below.\n");

  while (true) {
    const licenseKeyInput = (await ask("  License key: ")).trim();
    if (!licenseKeyInput) {
      console.log(`  A license key is required. Get one at: ${getPaymentUrl(tier)}\n`);
      continue;
    }
    console.log("  Activating license...");
    const result = await activateLicense(licenseKeyInput, ownerId, tier);
    if (result.success) {
      console.log("  License activated successfully!\n");
      break;
    } else {
      console.log(`  Activation failed: ${result.error}`);
      console.log("  Check your key and try again.\n");
    }
  }
  rl.close();

  // Completion summary
  console.log("Setup complete!");
  console.log(`  Bot: @${botUsername}`);
  console.log(`  Owner: ${ownerId}`);
  console.log("  License: Active");

  // Auto-install launchd service on macOS for startup persistence
  if (process.platform === "darwin") {
    console.log("\nInstalling auto-start service...");
    await cmdInstallService();
  } else {
    console.log("  Run: clautel start");
  }
}

async function cmdStart(): Promise<void> {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    console.log(`Already running (PID ${pid})`);
    return;
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("Not configured. Run: clautel setup");
    process.exit(1);
  }

  // On macOS with launchd service installed, use launchctl to start
  if (process.platform === "darwin" && fs.existsSync(getPlistPath())) {
    const load = spawn("launchctl", ["load", getPlistPath()], { stdio: "inherit" });
    load.on("close", (code) => {
      if (code === 0) {
        console.log("Started via launchd.");
        console.log(`Logs: clautel logs`);
      } else {
        console.error("Failed to start service via launchctl.");
      }
    });
    return;
  }

  // On macOS without service installed, install it now
  if (process.platform === "darwin") {
    console.log("Installing auto-start service...");
    await cmdInstallService();
    return;
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
  console.log(`Logs: clautel logs`);
}

function cmdStop(): void {
  // On macOS with launchd service installed, use launchctl to unload so
  // KeepAlive doesn't immediately restart the daemon
  if (process.platform === "darwin" && fs.existsSync(getPlistPath())) {
    const pid = readPid();
    const unload = spawn("launchctl", ["unload", getPlistPath()], { stdio: "inherit" });
    unload.on("close", (code) => {
      if (code === 0) {
        fs.rmSync(PID_FILE, { force: true });
        console.log("Stopped (launchd service unloaded).");
      } else {
        // Fall back to SIGTERM if launchctl fails
        if (pid && isRunning(pid)) {
          process.kill(pid, "SIGTERM");
          fs.rmSync(PID_FILE, { force: true });
          console.log(`Stopped (PID ${pid})`);
        } else {
          console.error("Failed to stop service via launchctl.");
        }
      }
    });
    return;
  }

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

async function cmdInstallService(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("install-service is only supported on macOS (launchd).");
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("Not configured. Run: clautel setup");
    process.exit(1);
  }

  const [cmd, args] = DAEMON_CMD;
  const programArgs = [cmd, ...args];

  // Capture environment variables needed by the daemon
  const envEntries: string[] = [
    `    <key>PATH</key>\n    <string>${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}</string>`,
    `    <key>HOME</key>\n    <string>${os.homedir()}</string>`,
  ];
  if (process.env.ANTHROPIC_API_KEY) {
    envEntries.push(`    <key>ANTHROPIC_API_KEY</key>\n    <string>${process.env.ANTHROPIC_API_KEY}</string>`);
  }

  // Include ngrok token from config if available
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      if (cfg.NGROK_AUTH_TOKEN) {
        envEntries.push(`    <key>NGROK_AUTH_TOKEN</key>\n    <string>${cfg.NGROK_AUTH_TOKEN}</string>`);
      }
    }
  } catch (error) {
    console.warn(`[warning] Could not read ngrok token from config file: ${(error as Error).message}`);
  }

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
${envEntries.join("\n")}
  </dict>
</dict>
</plist>`;

  // Stop any manually-started daemon first to avoid conflict
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    process.kill(existingPid, "SIGTERM");
    fs.rmSync(PID_FILE, { force: true });
  }

  const agentsDir = path.dirname(getPlistPath());
  fs.mkdirSync(agentsDir, { recursive: true });

  // Unload existing service if present (for clean reinstall)
  if (fs.existsSync(getPlistPath())) {
    try { spawn("launchctl", ["unload", getPlistPath()], { stdio: "ignore" }).unref(); } catch {}
    // Brief wait for unload to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

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
    console.error("Usage: clautel activate <license-key> [--plan pro|max]");
    process.exit(1);
  }

  // Parse optional --plan flag
  const { activateLicense, detectClaudePlan, getPlanLabel, isUnderLicensed, getPaymentUrl } = await import("./license.js");

  let planArg: "pro" | "max" | undefined;
  const planIdx = process.argv.indexOf("--plan");
  if (planIdx !== -1 && process.argv[planIdx + 1]) {
    const val = process.argv[planIdx + 1];
    if (val === "pro" || val === "max") planArg = val;
  }

  const { tier: detectedTier } = detectClaudePlan();
  const plan = planArg ?? detectedTier;

  // Enforce: can't use a plan lower than detected Claude plan
  if (isUnderLicensed(plan, detectedTier)) {
    console.error(`Your Claude plan is ${getPlanLabel(detectedTier)} — you cannot use a ${getPlanLabel(plan)} license.`);
    console.error(`Get a ${getPlanLabel(detectedTier)} license at: ${getPaymentUrl(detectedTier)}`);
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

  console.log(`Detected plan: ${getPlanLabel(plan)}`);
  console.log("Activating license...");
  const result = await activateLicense(key, ownerId, plan);
  if (result.success) {
    console.log("License activated successfully!");
    console.log("Restart the daemon to apply: clautel stop && clautel start");
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

async function cmdRecheck(): Promise<void> {
  const { loadLicense, validateLicense, activateLicense, saveLicense } = await import("./license.js");
  const state = loadLicense();

  if (!state.licenseKey) {
    console.error("No license found. Run: clautel activate <key>");
    process.exit(1);
  }

  console.log("Checking license with server...");
  const result = await validateLicense(state);

  if (result === "valid") {
    state.status = "active";
    state.lastValidatedAt = new Date().toISOString();
    state.lastValidationResult = true;
    state.graceStartedAt = null;
    state.warningsSent = 0;
    saveLicense(state);
    console.log("License is active.");
    console.log("Restart the daemon: clautel stop && clautel start");
    return;
  }

  if (result === "invalid") {
    console.error("Server says this license is cancelled or expired.");
    console.error("If you believe this is wrong, contact support.");
    process.exit(1);
  }

  // result === "error": server responded but rejected our stored instance.
  // Deactivate the stale instance first (frees the slot), then re-activate.
  console.log("Stored instance is stale — freeing slot and re-activating...");

  // Save key and plan before deactivation nulls them out
  const licenseKey = state.licenseKey;
  const plan = state.plan;

  const { deactivateLicense } = await import("./license.js");
  await deactivateLicense(state).catch(() => {}); // ignore errors — instance may already be gone

  let ownerId: number | undefined;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      ownerId = cfg.TELEGRAM_OWNER_ID;
    }
  } catch {}

  const reactivate = await activateLicense(licenseKey, ownerId, plan);
  if (reactivate.success) {
    console.log("License re-activated successfully.");
    console.log("Restart the daemon: clautel stop && clautel start");
  } else {
    console.error(`Re-activation failed: ${reactivate.error}`);
    console.error("Try manually: clautel deactivate && clautel activate <your-license-key>");
    process.exit(1);
  }
}

function cmdHelp(): void {
  console.log(`
Clautel — Telegram bridge for Claude Code

Usage: clautel <command>

Commands:
  setup              Configure your bot token and Telegram user ID
  start              Start the daemon in the background
  stop               Stop the daemon
  status             Show whether the daemon is running
  logs               Tail the daemon logs (Ctrl+C to exit)
  activate <key>     Activate a license key
  deactivate         Deactivate this machine's license
  license            Show current license status
  recheck            Force re-validate license with server (fixes false expired)
  install-service    Install as a macOS launchd service (auto-restart)
  uninstall-service  Remove the launchd service
  help               Show this help message

Getting started:
  1. clautel setup
  2. clautel start
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
    cmdStart().catch((err) => { console.error(err); process.exit(1); });
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
  case "recheck":
    cmdRecheck().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "install-service":
    cmdInstallService().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "uninstall-service":
    cmdUninstallService();
    break;
  default:
    cmdHelp();
}
