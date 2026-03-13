const AUTO_CLOSE_MS = 30 * 60 * 1000; // 30 minutes

interface TunnelEntry {
  url: string;
  port: number;
  listener: { url(): string | null | undefined; close(): Promise<void> };
  timer: NodeJS.Timeout;
}

export class TunnelManager {
  private tunnels = new Map<number, TunnelEntry>();
  private authToken: string | undefined;
  private onAutoClose?: (chatId: number, port: number) => void;

  constructor(authToken?: string) {
    this.authToken = authToken;
  }

  setAuthToken(token: string | undefined): void {
    this.authToken = token;
  }

  setAutoCloseCallback(cb: (chatId: number, port: number) => void): void {
    this.onAutoClose = cb;
  }

  private createAutoCloseTimer(chatId: number): NodeJS.Timeout {
    return setTimeout(() => {
      const entry = this.tunnels.get(chatId);
      if (entry) {
        this.closeTunnel(chatId).catch(() => {});
        this.onAutoClose?.(chatId, entry.port);
      }
    }, AUTO_CLOSE_MS);
  }

  async openTunnel(chatId: number, port: number): Promise<string> {
    if (!this.authToken) {
      throw new Error("No ngrok token configured. Run `clautel setup` or set NGROK_AUTH_TOKEN environment variable.");
    }

    // Close existing tunnel for this chat
    await this.closeTunnel(chatId);

    // Lazy-load ngrok to avoid loading the native binary at startup.
    // This prevents crashes on systems where Application Control policies
    // block the native module, as long as tunnels aren't used.
    const ngrok = await import("@ngrok/ngrok");
    const listener = await ngrok.forward({
      addr: port,
      authtoken: this.authToken,
    });

    const url = listener.url();
    if (!url) {
      throw new Error("Failed to get tunnel URL from ngrok.");
    }

    const timer = this.createAutoCloseTimer(chatId);
    this.tunnels.set(chatId, { url, port, listener, timer });
    return url;
  }

  resetTimer(chatId: number): void {
    const entry = this.tunnels.get(chatId);
    if (!entry) return;

    clearTimeout(entry.timer);
    entry.timer = this.createAutoCloseTimer(chatId);
  }

  async closeTunnel(chatId: number): Promise<boolean> {
    const entry = this.tunnels.get(chatId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    try {
      await entry.listener.close();
    } catch {}
    this.tunnels.delete(chatId);
    return true;
  }

  hasTunnel(chatId: number): boolean {
    return this.tunnels.has(chatId);
  }

  getTunnelInfo(chatId: number): { url: string; port: number } | undefined {
    const entry = this.tunnels.get(chatId);
    if (!entry) return undefined;
    return { url: entry.url, port: entry.port };
  }

  async closeAll(): Promise<void> {
    const chatIds = [...this.tunnels.keys()];
    for (const chatId of chatIds) {
      await this.closeTunnel(chatId);
    }
  }
}

export function parsePort(input: string): number | null {
  // Try plain number: "3000"
  const num = Number(input);
  if (!isNaN(num) && num > 0 && num <= 65535 && String(Math.floor(num)) === input) {
    return num;
  }

  // Try URL-like: "localhost:3000", "http://localhost:3000", "http://localhost:3000/dashboard"
  try {
    let urlStr = input;
    if (!urlStr.includes("://")) {
      urlStr = `http://${urlStr}`;
    }
    const url = new URL(urlStr);
    const port = Number(url.port);
    if (port > 0 && port <= 65535) return port;
  } catch {}

  return null;
}
