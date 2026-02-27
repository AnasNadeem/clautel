import puppeteer from "puppeteer";
import type { Browser, Page } from "puppeteer";

export interface ScreenshotMessageRef {
  messageId: number;
  chatId: number;
}

export interface BrowserActionResult {
  screenshotBuffer: Buffer;
  url: string;
  title: string;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private pages = new Map<number, Page>();
  private screenshotMessages = new Map<number, ScreenshotMessageRef>();

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser;
    this.browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    return this.browser;
  }

  hasPage(chatId: number): boolean {
    return this.pages.has(chatId);
  }

  async openPage(chatId: number, url: string): Promise<BrowserActionResult> {
    const browser = await this.ensureBrowser();
    const existing = this.pages.get(chatId);
    if (existing && !existing.isClosed()) await existing.close().catch(() => {});
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    this.pages.set(chatId, page);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    return this.takeScreenshot(chatId);
  }

  async takeScreenshot(chatId: number): Promise<BrowserActionResult> {
    const page = this.pages.get(chatId);
    if (!page || page.isClosed()) throw new Error("No browser open. Use /preview <url> to start one.");
    const screenshotBuffer = (await page.screenshot({ type: "png" })) as Buffer;
    const url = page.url();
    const title = await page.title().catch(() => url);
    return { screenshotBuffer, url, title };
  }

  async click(chatId: number, x: number, y: number): Promise<BrowserActionResult> {
    const page = this.pages.get(chatId);
    if (!page || page.isClosed()) throw new Error("No browser open. Use /preview <url> to start one.");
    await page.mouse.click(x, y);
    await new Promise((r) => setTimeout(r, 500));
    return this.takeScreenshot(chatId);
  }

  async scroll(chatId: number, direction: "up" | "down", amount: number): Promise<BrowserActionResult> {
    const page = this.pages.get(chatId);
    if (!page || page.isClosed()) throw new Error("No browser open. Use /preview <url> to start one.");
    await page.mouse.wheel({ deltaY: direction === "down" ? amount : -amount });
    await new Promise((r) => setTimeout(r, 300));
    return this.takeScreenshot(chatId);
  }

  async navigate(chatId: number, url: string): Promise<BrowserActionResult> {
    const page = this.pages.get(chatId);
    if (!page || page.isClosed()) throw new Error("No browser open. Use /preview <url> to start one.");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    return this.takeScreenshot(chatId);
  }

  async goBack(chatId: number): Promise<BrowserActionResult> {
    const page = this.pages.get(chatId);
    if (!page || page.isClosed()) throw new Error("No browser open. Use /preview <url> to start one.");
    await page.goBack({ waitUntil: "networkidle2" }).catch(() => {});
    return this.takeScreenshot(chatId);
  }

  async goForward(chatId: number): Promise<BrowserActionResult> {
    const page = this.pages.get(chatId);
    if (!page || page.isClosed()) throw new Error("No browser open. Use /preview <url> to start one.");
    await page.goForward({ waitUntil: "networkidle2" }).catch(() => {});
    return this.takeScreenshot(chatId);
  }

  async refresh(chatId: number): Promise<BrowserActionResult> {
    const page = this.pages.get(chatId);
    if (!page || page.isClosed()) throw new Error("No browser open. Use /preview <url> to start one.");
    await page.reload({ waitUntil: "networkidle2" }).catch(() => {});
    return this.takeScreenshot(chatId);
  }

  async typeText(chatId: number, text: string): Promise<BrowserActionResult> {
    const page = this.pages.get(chatId);
    if (!page || page.isClosed()) throw new Error("No browser open. Use /preview <url> to start one.");
    await page.keyboard.type(text);
    await new Promise((r) => setTimeout(r, 300));
    return this.takeScreenshot(chatId);
  }

  async closePage(chatId: number): Promise<void> {
    const page = this.pages.get(chatId);
    if (page && !page.isClosed()) await page.close().catch(() => {});
    this.pages.delete(chatId);
    this.screenshotMessages.delete(chatId);
  }

  getScreenshotMessage(chatId: number): ScreenshotMessageRef | undefined {
    return this.screenshotMessages.get(chatId);
  }

  setScreenshotMessage(chatId: number, ref: ScreenshotMessageRef): void {
    this.screenshotMessages.set(chatId, ref);
  }

  clearScreenshotMessage(chatId: number): void {
    this.screenshotMessages.delete(chatId);
  }

  async close(): Promise<void> {
    for (const [chatId, page] of this.pages) {
      if (!page.isClosed()) await page.close().catch(() => {});
      this.pages.delete(chatId);
    }
    this.screenshotMessages.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
