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

// For global installs, compiledDaemon exists and we use node directly (no shell needed).
// For local dev, we use npx tsx — resolve npx to a full path to avoid shell:true on Windows.
function resolveDaemonCmd(): [string, string[]] {
  if (fs.existsSync(compiledDaemon)) {
    return [process.execPath, [compiledDaemon]];
  }
  // Local dev: use node to run npx-cli.js directly (avoids shell:true on Windows)
  if (process.platform === "win32") {
    const npmDir = path.dirname(process.execPath);
    const npxCli = path.join(npmDir, "node_modules", "npm", "bin", "npx-cli.js");
    if (fs.existsSync(npxCli)) {
      return [process.execPath, [npxCli, "tsx", srcDaemon]];
    }
  }
  return ["npx", ["tsx", srcDaemon]];
}

const DAEMON_CMD = resolveDaemonCmd();

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

function spawnExec(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(cmd, args, {
      stdio: ["ignore", "ignore", "pipe"],
      ...(process.platform === "win32" && { windowsHide: true }),
    });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    child.on("error", (err) => resolve({ code: 1, stderr: err.message }));
  });
}

function launchctlExec(args: string[]): Promise<{ code: number; stderr: string }> {
  return spawnExec("launchctl", args);
}

function systemctlExec(args: string[]): Promise<{ code: number; stderr: string }> {
  return spawnExec("systemctl", ["--user", ...args]);
}

function hasSystemd(): boolean {
  try {
    fs.accessSync("/run/systemd/system");
    return true;
  } catch {
    return false;
  }
}

function getSystemdServicePath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", "clautel.service");
}

// --- Windows startup helpers (Registry Run key + hidden VBS launcher) ---
const STARTUP_REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STARTUP_REG_VALUE = "Clautel";

function regExec(args: string[]): Promise<{ code: number; stderr: string }> {
  return spawnExec("reg.exe", args);
}

function getStartupVbsPath(): string {
  return path.join(DATA_DIR, "start.vbs");
}

function getDaemonCmdPath(): string {
  return path.join(DATA_DIR, "daemon.cmd");
}

/** Write the .cmd and .vbs launcher files used by both startDirect and auto-start. */
function ensureWindowsLaunchers(): void {
  const [cmd, args] = DAEMON_CMD;
  const cmdLine = `@echo off\r\n"${cmd}" ${args.map((a) => `"${a}"`).join(" ")} >> "${LOG_FILE}" 2>&1\r\n`;
  fs.writeFileSync(getDaemonCmdPath(), cmdLine);

  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${getDaemonCmdPath()}""", 0, False\r\n`;
  fs.writeFileSync(getStartupVbsPath(), vbsContent);
}

async function hasWindowsStartup(): Promise<boolean> {
  const { code } = await regExec(["query", STARTUP_REG_KEY, "/v", STARTUP_REG_VALUE]);
  return code === 0;
}

/** Poll for daemon PID file + running process. Returns PID or null on timeout. */
async function waitForDaemon(timeoutMs = 10_000, intervalMs = 200): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPid();
    if (pid && isRunning(pid)) return pid;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/** Read the last N bytes of a file and return the last `lineCount` lines. */
function readTailLines(filePath: string, lineCount: number, maxBytes = 32_768): string[] {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return [];
  }
  try {
    const stat = fs.fstatSync(fd);
    const readSize = Math.min(stat.size, maxBytes);
    if (readSize === 0) return [];
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    const lines = buf.toString("utf-8").split("\n");
    // If the file was larger than maxBytes, the first "line" is likely truncated — drop it
    if (stat.size > maxBytes) lines.shift();
    // Drop trailing empty line from final newline
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-lineCount);
  } finally {
    fs.closeSync(fd);
  }
}

function startDirect(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  rotateLog();

  // On Windows, use VBS launcher to start the daemon fully hidden (no console window).
  // detached: true + windowsHide: true doesn't reliably hide the window.
  if (process.platform === "win32") {
    ensureWindowsLaunchers();
    const child = spawn("wscript.exe", [getStartupVbsPath()], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    // Daemon writes its own PID file — wait for it
    console.log("Starting daemon...");
    waitForDaemon().then((pid) => {
      if (pid) {
        console.log(`Started (PID ${pid})`);
        console.log(`Logs: clautel logs`);
      } else {
        console.error("Daemon did not start. Check logs: clautel logs");
      }
    });
    return;
  }

  const logFd = fs.openSync(LOG_FILE, "a");

  const [cmd, args] = DAEMON_CMD;
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.on("error", (err) => {
    console.error(`Failed to start daemon: ${err.message}`);
    fs.rmSync(PID_FILE, { force: true });
  });

  if (child.pid == null) {
    fs.closeSync(logFd);
    console.error("Failed to start daemon: spawn returned no PID.");
    return;
  }

  child.unref();
  fs.closeSync(logFd);
  fs.writeFileSync(PID_FILE, String(child.pid));

  console.log(`Started (PID ${child.pid})`);
  console.log(`Logs: clautel logs`);
}

async function cmdSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, prefill = ""): Promise<string> =>
    new Promise((resolve) => {
      rl.question(q, resolve);
      if (prefill) rl.write(prefill);
    });

  // Load existing config for defaults
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      existing = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  const prevToken = typeof existing.TELEGRAM_BOT_TOKEN === "string" ? existing.TELEGRAM_BOT_TOKEN : "";
  const prevOwnerId = typeof existing.TELEGRAM_OWNER_ID === "number" ? existing.TELEGRAM_OWNER_ID : 0;
  const prevNgrok = typeof existing.NGROK_AUTH_TOKEN === "string" ? existing.NGROK_AUTH_TOKEN : "";
  const prevApiKey = typeof existing.ANTHROPIC_API_KEY === "string" ? existing.ANTHROPIC_API_KEY : "";
  const prevPlan = typeof existing.claudePlan === "string" ? existing.claudePlan : "";

  // Save config incrementally so partial progress survives crashes
  const saveConfig = (data: Record<string, unknown>) => {
    Object.assign(existing, data);
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
  };

  console.log("Clautel — Setup\n");
  if (prevToken) console.log("  Existing config detected. Edit pre-filled values or press Enter to keep them.\n");

  // Step 1/4: Bot token with live validation
  console.log("Step 1/4: Manager Bot");
  console.log("  Create a bot via @BotFather on Telegram and paste the token here.");
  console.log("  It looks like: 123456:ABC-DEF...\n");

  let token = "";
  let botUsername = "";
  let tokenFirstAsk = true;
  while (true) {
    const input = (await ask("  Bot token: ", tokenFirstAsk ? prevToken : "")).trim();
    tokenFirstAsk = false;

    if (!input || !/^\d+:[A-Za-z0-9_-]+$/.test(input)) {
      console.log("  Invalid format. Token looks like: 123456:ABC-DEF...\n");
      continue;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${input}/getMe`);
      const data = (await res.json()) as { ok: boolean; result?: { username: string } };
      if (!data.ok) {
        console.log("  Token rejected by Telegram. Check it and try again.\n");
        continue;
      }
      token = input;
      botUsername = data.result!.username;
      console.log(`  Connected to @${botUsername}\n`);
      break;
    } catch {
      console.log("  Could not reach Telegram API. Check your connection.\n");
      continue;
    }
  }
  saveConfig({ TELEGRAM_BOT_TOKEN: token });

  // Step 2/4: Owner Telegram ID
  console.log("Step 2/4: Your Telegram ID");
  console.log("  This ensures only you can use the bot.");
  console.log("  To find your ID:");
  console.log("    1. Open Telegram and search for @userinfobot");
  console.log("    2. Send it any message — it replies with your user ID\n");

  let ownerId = 0;
  let ownerFirstAsk = true;
  while (true) {
    const ownerIdStr = (await ask("  Your Telegram user ID: ", ownerFirstAsk && prevOwnerId ? String(prevOwnerId) : "")).trim();
    ownerFirstAsk = false;

    ownerId = parseInt(ownerIdStr, 10);
    if (!ownerIdStr || isNaN(ownerId) || ownerId <= 0) {
      console.log("  Invalid ID — must be a positive number.\n");
      continue;
    }
    console.log(`  Owner set to ${ownerId}\n`);
    break;
  }
  saveConfig({ TELEGRAM_OWNER_ID: ownerId });

  // Step 3: Ngrok Configuration (optional, for live preview)
  console.log("Step 3/4: Ngrok Configuration (for live preview)");
  console.log("  To preview your dev server from your phone, Clautel can create ngrok tunnels.");
  console.log("  Get a free auth token at: https://dashboard.ngrok.com/get-started/your-authtoken");
  console.log("  Press Enter to skip.\n");

  const ngrokToken = (await ask("  Ngrok auth token: ", prevNgrok)).trim();
  if (ngrokToken) {
    console.log("  Ngrok token saved.\n");
  } else {
    console.log("  Skipped — you can configure it later via NGROK_AUTH_TOKEN env var or re-run setup.\n");
  }

  // Step 3b: Anthropic API key (optional)
  console.log("  Anthropic API key (optional):");
  console.log("  If you skip this, Clautel will use your Claude Code CLI login (from 'claude login').");
  console.log("  Only needed if you want to use an API key instead, or if the auto-start service");
  console.log("  can't access your CLI login session.");
  console.log("  Press Enter to skip.\n");

  const anthropicKey = (await ask("  Anthropic API key: ", prevApiKey)).trim();
  if (anthropicKey) {
    console.log("  API key saved.\n");
  } else {
    console.log("  Skipped — will use Claude Code CLI authentication.\n");
  }

  // Save optional fields
  if (ngrokToken) saveConfig({ NGROK_AUTH_TOKEN: ngrokToken });
  else { delete existing.NGROK_AUTH_TOKEN; saveConfig({}); }
  if (anthropicKey) saveConfig({ ANTHROPIC_API_KEY: anthropicKey });
  else { delete existing.ANTHROPIC_API_KEY; saveConfig({}); }

  // Step 4/4: License
  const { getPaymentUrl, activateLicense, getPlanLabel, saveClaudePlan, createSelfHostLicense, saveLicense, loadLicense } = await import("./license.js");

  const existingLicense = loadLicense();
  const hasActiveLicense = existingLicense.status === "active" && existingLicense.plan !== "selfhost";

  console.log("Step 4/4: License\n");
  console.log("  Choose your plan:\n");
  console.log("    [0] Self-Host — Free");
  console.log("        Up to 5 project bots, no license key needed\n");
  console.log("    [1] Pro — $4/mo");
  console.log("        Up to 5 project bots\n");
  console.log("    [2] Max — $9/mo (Recommended)");
  console.log("        Unlimited project bots\n");

  const planPrefill = prevPlan === "max" ? "2" : prevPlan === "pro" ? "1" : "0";

  let tier: "pro" | "max" | "selfhost" = "selfhost";
  let planFirstAsk = true;
  while (true) {
    const choice = (await ask("  Select plan (0, 1, or 2): ", planFirstAsk ? planPrefill : "")).trim();
    planFirstAsk = false;
    if (choice === "0" || !choice) { tier = "selfhost"; break; }
    if (choice === "1") { tier = "pro"; break; }
    if (choice === "2") { tier = "max"; break; }
    console.log("  Please enter 0, 1, or 2.\n");
  }
  saveClaudePlan(tier);

  if (tier === "selfhost") {
    const selfHostState = createSelfHostLicense();
    saveLicense(selfHostState);
    console.log("\n  Self-host license activated. No key required.\n");
  } else if (hasActiveLicense && existingLicense.plan === tier) {
    // Already have an active license for this plan — keep it
    console.log(`\n  Kept existing ${getPlanLabel(tier)} license.\n`);
  } else {
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
  }
  rl.close();

  // Completion summary
  console.log("Setup complete!");
  console.log(`  Bot: @${botUsername}`);
  console.log(`  Owner: ${ownerId}`);
  console.log("  License: Active");

  // Auto-install service on macOS (launchd) and Linux (systemd) for startup persistence
  if (process.platform === "darwin" || (process.platform === "linux" && hasSystemd()) || process.platform === "win32") {
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
    // Unload stale service first — fixes "Load failed: 5: Input/output error"
    // which occurs when the plist is already loaded from a previous session
    await launchctlExec(["unload", getPlistPath()]);

    const { code, stderr } = await launchctlExec(["load", getPlistPath()]);

    // launchctl can exit 0 even on failure (macOS quirk) — check stderr too
    const loadFailed = code !== 0 || stderr.includes("Load failed");

    if (loadFailed) {
      console.error(`launchd: ${stderr.trim() || `exit code ${code}`}`);
      console.log("Starting directly instead...");
      startDirect();
      return;
    }

    const newPid = await waitForDaemon();
    if (newPid) {
      console.log(`Started via launchd (PID ${newPid})`);
      console.log(`Logs: clautel logs`);
    } else {
      // Daemon didn't start — show diagnostics and fall back to direct
      console.error("Daemon did not start via launchd.");
      if (fs.existsSync(LOG_FILE)) {
        const lines = readTailLines(LOG_FILE, 5);
        if (lines.length > 0) {
          console.error("Recent logs:\n  " + lines.join("\n  "));
        }
      } else {
        console.error("No log file — daemon crashed before writing output.");
        console.error("Run manually to see errors:");
        console.error(`  ${DAEMON_CMD[0]} ${DAEMON_CMD[1].join(" ")}`);
      }
      console.log("\nFalling back to direct start...");
      await launchctlExec(["unload", getPlistPath()]);
      startDirect();
    }
    return;
  }

  // On macOS without service installed, install it now
  if (process.platform === "darwin") {
    console.log("Installing auto-start service...");
    await cmdInstallService();
    return;
  }

  // On Linux with systemd service installed, use systemctl to start
  if (process.platform === "linux" && fs.existsSync(getSystemdServicePath())) {
    const { code, stderr } = await systemctlExec(["start", "clautel"]);
    if (code !== 0) {
      console.error(`systemd: ${stderr.trim() || `exit code ${code}`}`);
      console.log("Starting directly instead...");
      startDirect();
      return;
    }

    const newPid = await waitForDaemon();
    if (newPid) {
      console.log(`Started via systemd (PID ${newPid})`);
      console.log(`Logs: clautel logs`);
    } else {
      console.error("Daemon did not start via systemd.");
      if (fs.existsSync(LOG_FILE)) {
        const lines = readTailLines(LOG_FILE, 5);
        if (lines.length > 0) {
          console.error("Recent logs:\n  " + lines.join("\n  "));
        }
      } else {
        console.error("No log file — daemon crashed before writing output.");
        console.error("Run manually to see errors:");
        console.error(`  ${DAEMON_CMD[0]} ${DAEMON_CMD[1].join(" ")}`);
      }
      console.log("\nFalling back to direct start...");
      await systemctlExec(["stop", "clautel"]);
      startDirect();
    }
    return;
  }

  // On Linux without service, install systemd service if available
  if (process.platform === "linux" && hasSystemd()) {
    console.log("Installing auto-start service...");
    await cmdInstallService();
    return;
  }

  // On Windows without startup entry, install it first
  if (process.platform === "win32" && !await hasWindowsStartup()) {
    console.log("Installing auto-start service...");
    await cmdInstallService();
    return;
  }

  // On Windows with startup entry, just start directly
  if (process.platform === "win32") {
    startDirect();
    return;
  }

  startDirect();
}

async function cmdStop(): Promise<void> {
  // On macOS with launchd service installed, use launchctl to unload so
  // KeepAlive doesn't immediately restart the daemon
  if (process.platform === "darwin" && fs.existsSync(getPlistPath())) {
    const pid = readPid();
    const { code } = await launchctlExec(["unload", getPlistPath()]);
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
        fs.rmSync(PID_FILE, { force: true });
        console.log("Not running.");
      }
    }
    return;
  }

  // On Linux with systemd service installed, use systemctl to stop so
  // Restart=always doesn't immediately restart the daemon
  if (process.platform === "linux" && fs.existsSync(getSystemdServicePath())) {
    const pid = readPid();
    const { code } = await systemctlExec(["stop", "clautel"]);
    if (code === 0) {
      fs.rmSync(PID_FILE, { force: true });
      console.log("Stopped (systemd service stopped).");
    } else {
      if (pid && isRunning(pid)) {
        process.kill(pid, "SIGTERM");
        fs.rmSync(PID_FILE, { force: true });
        console.log(`Stopped (PID ${pid})`);
      } else {
        fs.rmSync(PID_FILE, { force: true });
        console.log("Not running.");
      }
    }
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

  // Print last 50 lines using tail-read (reads only last 32KB, not entire file)
  const tailLines = readTailLines(LOG_FILE, 50);
  if (tailLines.length > 0) {
    process.stdout.write(tailLines.join("\n") + "\n");
  }

  // Follow mode: watch for changes and print new content
  let position = fs.statSync(LOG_FILE).size;
  const MAX_READ_CHUNK = 1024 * 1024; // 1MB cap per read to prevent OOM

  const watcher = fs.watch(LOG_FILE, () => {
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size < position) {
        // File was truncated (log rotation) — reset
        position = 0;
      }
      if (stat.size > position) {
        const readSize = Math.min(stat.size - position, MAX_READ_CHUNK);
        const fd = fs.openSync(LOG_FILE, "r");
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, position);
        fs.closeSync(fd);
        process.stdout.write(buf);
        position += readSize;
      }
    } catch (err) {
      console.error(`Log watch error: ${(err as Error).message}`);
    }
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}

function getPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

async function cmdInstallService(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
    console.error("install-service is supported on macOS (launchd), Linux (systemd), and Windows.");
    process.exit(1);
  }

  if (process.platform === "linux" && !hasSystemd()) {
    console.error("systemd not detected. install-service requires systemd.");
    console.error("You can still run: clautel start (runs as a background process).");
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("Not configured. Run: clautel setup");
    process.exit(1);
  }

  // Stop any manually-started daemon first to avoid conflict
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    process.kill(existingPid, "SIGTERM");
    fs.rmSync(PID_FILE, { force: true });
  }

  if (process.platform === "darwin") {
    await installLaunchdService();
  } else if (process.platform === "win32") {
    await installWindowsStartup();
  } else {
    await installSystemdService();
  }
}

async function installLaunchdService(): Promise<void> {
  const [cmd, args] = DAEMON_CMD;
  const programArgs = [cmd, ...args];

  // Only PATH and HOME in the plist — secrets come from ~/.clautel/config.json at runtime
  const envEntries: string[] = [
    `    <key>PATH</key>\n    <string>${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}</string>`,
    `    <key>HOME</key>\n    <string>${os.homedir()}</string>`,
  ];

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
  <key>ThrottleInterval</key>
  <integer>35</integer>
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

  const agentsDir = path.dirname(getPlistPath());
  fs.mkdirSync(agentsDir, { recursive: true });

  // Unload existing service if present (properly awaited for clean reinstall)
  if (fs.existsSync(getPlistPath())) {
    await launchctlExec(["unload", getPlistPath()]);
  }

  fs.writeFileSync(getPlistPath(), plist, { mode: 0o600 });

  const { code, stderr } = await launchctlExec(["load", getPlistPath()]);
  const loadFailed = code !== 0 || stderr.includes("Load failed");

  if (loadFailed) {
    console.error(`launchd: ${stderr.trim() || `exit code ${code}`}`);
    console.log("Starting daemon directly instead...");
    startDirect();
    return;
  }

  const newPid = await waitForDaemon();
  if (newPid) {
    console.log("Service installed and started.");
    console.log(`Plist: ${getPlistPath()}`);
    console.log("The daemon will auto-restart on crash and start at login.");
  } else {
    console.error("Service installed but daemon did not start.");
    if (fs.existsSync(LOG_FILE)) {
      const lines = readTailLines(LOG_FILE, 5);
      if (lines.length > 0) {
        console.error("Recent logs:\n  " + lines.join("\n  "));
      }
    } else {
      console.error("No log file — daemon crashed before writing output.");
      console.error("Run manually to see errors:");
      console.error(`  ${DAEMON_CMD[0]} ${DAEMON_CMD[1].join(" ")}`);
    }
    console.log("\nFalling back to direct start...");
    await launchctlExec(["unload", getPlistPath()]);
    startDirect();
  }
}

async function installSystemdService(): Promise<void> {
  const [cmd, args] = DAEMON_CMD;
  const execStart = [cmd, ...args].join(" ");

  const unit = `[Unit]
Description=Clautel - Telegram bridge for Claude Code
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=10
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
Environment=HOME=${os.homedir()}
Environment=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}

[Install]
WantedBy=default.target
`;

  const serviceDir = path.dirname(getSystemdServicePath());
  fs.mkdirSync(serviceDir, { recursive: true });

  // Stop existing service if present (for clean reinstall)
  if (fs.existsSync(getSystemdServicePath())) {
    await systemctlExec(["stop", "clautel"]);
  }

  fs.writeFileSync(getSystemdServicePath(), unit, { mode: 0o644 });

  await systemctlExec(["daemon-reload"]);
  await systemctlExec(["enable", "clautel"]);
  const { code, stderr } = await systemctlExec(["start", "clautel"]);

  if (code !== 0) {
    console.error(`systemd: ${stderr.trim() || `exit code ${code}`}`);
    console.log("Starting daemon directly instead...");
    startDirect();
    return;
  }

  const newPid = await waitForDaemon();
  if (newPid) {
    console.log("Service installed and started.");
    console.log(`Unit: ${getSystemdServicePath()}`);
    console.log("The daemon will auto-restart on crash and start at login.");
  } else {
    console.error("Service installed but daemon did not start.");
    if (fs.existsSync(LOG_FILE)) {
      const lines = readTailLines(LOG_FILE, 5);
      if (lines.length > 0) {
        console.error("Recent logs:\n  " + lines.join("\n  "));
      }
    } else {
      console.error("No log file — daemon crashed before writing output.");
      console.error("Run manually to see errors:");
      console.error(`  ${DAEMON_CMD[0]} ${DAEMON_CMD[1].join(" ")}`);
    }
    console.log("\nFalling back to direct start...");
    await systemctlExec(["stop", "clautel"]);
    startDirect();
  }
}

async function installWindowsStartup(): Promise<void> {
  ensureWindowsLaunchers();

  // Add to Windows startup via Registry Run key (no admin needed)
  const regData = `wscript.exe "${getStartupVbsPath()}"`;
  const { code, stderr } = await regExec([
    "add", STARTUP_REG_KEY, "/v", STARTUP_REG_VALUE,
    "/t", "REG_SZ", "/d", regData, "/f",
  ]);

  if (code !== 0) {
    console.error(`Registry: ${stderr.trim() || `exit code ${code}`}`);
    console.log("Starting daemon directly instead...");
    startDirect();
    return;
  }

  // Start the daemon now
  startDirect();
  console.log("Auto-start registered. The daemon will start at login.");
}

async function cmdUninstallService(): Promise<void> {
  if (process.platform === "darwin") {
    if (!fs.existsSync(getPlistPath())) {
      console.log("Service not installed.");
      return;
    }
    await launchctlExec(["unload", getPlistPath()]);
    fs.rmSync(getPlistPath(), { force: true });
    console.log("Service uninstalled.");
    return;
  }

  if (process.platform === "linux") {
    if (!fs.existsSync(getSystemdServicePath())) {
      console.log("Service not installed.");
      return;
    }
    await systemctlExec(["stop", "clautel"]);
    await systemctlExec(["disable", "clautel"]);
    fs.rmSync(getSystemdServicePath(), { force: true });
    await systemctlExec(["daemon-reload"]);
    console.log("Service uninstalled.");
    return;
  }

  if (process.platform === "win32") {
    if (!await hasWindowsStartup()) {
      console.log("Service not installed.");
      return;
    }
    await regExec(["delete", STARTUP_REG_KEY, "/v", STARTUP_REG_VALUE, "/f"]);
    fs.rmSync(getStartupVbsPath(), { force: true });
    fs.rmSync(getDaemonCmdPath(), { force: true });
    fs.rmSync(PID_FILE, { force: true });
    console.log("Service uninstalled.");
    return;
  }

  console.error("install-service is supported on macOS (launchd), Linux (systemd), and Windows (Registry startup).");
  process.exit(1);
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
  install-service    Install as a system service (macOS / Linux / Windows)
  uninstall-service  Remove the system service
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
    cmdStop().catch((err) => { console.error(err); process.exit(1); });
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
    cmdUninstallService().catch((err) => { console.error(err); process.exit(1); });
    break;
  default:
    cmdHelp();
}
