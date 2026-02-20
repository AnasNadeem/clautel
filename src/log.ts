const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BOLD = "\x1b[1m";

function ts(): string {
  return DIM + new Date().toLocaleTimeString("en-GB", { hour12: false }) + RESET;
}

export function logUser(text: string) {
  const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
  console.log(`${ts()} ${BOLD}${CYAN}YOU${RESET}  ${preview}`);
}

export function logStatus(status: string) {
  console.log(`${ts()} ${DIM}${MAGENTA}...${RESET}  ${DIM}${status}${RESET}`);
}

export function logStream(text: string) {
  const preview = text.length > 300 ? text.slice(0, 300) + "..." : text;
  console.log(`${ts()} ${GREEN}Claude${RESET}  ${preview}`);
}

export function logTool(toolName: string, detail?: string) {
  const suffix = detail ? ` ${DIM}${detail}${RESET}` : "";
  console.log(`${ts()} ${YELLOW}TOOL${RESET}  ${toolName}${suffix}`);
}

export function logApproval(toolName: string, approved: boolean) {
  const tag = approved ? `${GREEN}APPROVED${RESET}` : `${RED}DENIED${RESET}`;
  console.log(`${ts()} ${tag}  ${toolName}`);
}

export function logResult(tokens: number, turns: number, seconds: string) {
  console.log(`${ts()} ${DIM}DONE${RESET}  ${tokens.toLocaleString()} tokens | ${turns} turns | ${seconds}s`);
}

export function logError(message: string) {
  console.log(`${ts()} ${RED}ERROR${RESET}  ${message}`);
}
