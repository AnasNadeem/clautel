const isTTY = process.stdout.isTTY ?? false;

const RESET = isTTY ? "\x1b[0m" : "";
const DIM = isTTY ? "\x1b[2m" : "";
const CYAN = isTTY ? "\x1b[36m" : "";
const GREEN = isTTY ? "\x1b[32m" : "";
const YELLOW = isTTY ? "\x1b[33m" : "";
const RED = isTTY ? "\x1b[31m" : "";
const MAGENTA = isTTY ? "\x1b[35m" : "";
const BOLD = isTTY ? "\x1b[1m" : "";

function ts(): string {
  return DIM + new Date().toLocaleTimeString("en-GB", { hour12: false }) + RESET;
}

function prefix(tag?: string): string {
  return tag ? `${DIM}[${tag}]${RESET} ` : "";
}

export function logUser(text: string, tag?: string) {
  const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
  console.log(`${ts()} ${prefix(tag)}${BOLD}${CYAN}YOU${RESET}  ${preview}`);
}

export function logStatus(status: string, tag?: string) {
  console.log(`${ts()} ${prefix(tag)}${DIM}${MAGENTA}...${RESET}  ${DIM}${status}${RESET}`);
}

export function logStream(text: string, tag?: string) {
  const preview = text.length > 300 ? text.slice(0, 300) + "..." : text;
  console.log(`${ts()} ${prefix(tag)}${GREEN}Claude${RESET}  ${preview}`);
}

export function logTool(toolName: string, detail?: string, tag?: string) {
  const suffix = detail ? ` ${DIM}${detail}${RESET}` : "";
  console.log(`${ts()} ${prefix(tag)}${YELLOW}TOOL${RESET}  ${toolName}${suffix}`);
}

export function logApproval(toolName: string, result: "allow" | "always" | "deny", tag?: string) {
  const label =
    result === "allow"  ? `${GREEN}APPROVED${RESET}` :
    result === "always" ? `${GREEN}ALWAYS${RESET}  ` :
                          `${RED}DENIED${RESET}  `;
  console.log(`${ts()} ${prefix(tag)}${label}  ${toolName}`);
}

export function logResult(tokens: number, turns: number, seconds: string, tag?: string) {
  console.log(`${ts()} ${prefix(tag)}${DIM}DONE${RESET}  ${tokens.toLocaleString()} tokens | ${turns} turns | ${seconds}s`);
}

export function logError(message: string, tag?: string) {
  console.log(`${ts()} ${prefix(tag)}${RED}ERROR${RESET}  ${message}`);
}
