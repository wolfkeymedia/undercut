/**
 * Loads a page in a headless browser and returns the HTML after its scripts
 * have run. Needed for stores that fill in prices with JavaScript, where the
 * HTML as downloaded only holds placeholders.
 */
export interface Renderer {
  render(url: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Starts a headless Chromium through Playwright, if it is installed
 * (`npm install` adds it; then `npx playwright install chromium` once).
 * Returns null when it isn't, so collection carries on without rendering.
 */
export async function browserRenderer(options: { timeoutMs?: number } = {}): Promise<Renderer | null> {
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    return null;
  }
  let browser: import("playwright").Browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (err) {
    console.warn(`Headless browser unavailable, so JavaScript-rendered stores will be skipped: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
  const context = await browser.newContext({
    userAgent: process.env.UNDERCUT_USER_AGENT || "UndercutBot/0.1 (+https://github.com/wolfkeymedia/undercut)",
  });
  // Prices don't need images, fonts or video; skipping them keeps each page light for the store too.
  await context.route("**/*", (route) =>
    ["image", "font", "media"].includes(route.request().resourceType()) ? route.abort() : route.continue(),
  );

  return {
    async render(url) {
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: options.timeoutMs ?? 30_000 });
        return await page.content();
      } finally {
        await page.close();
      }
    },
    async close() {
      await browser.close();
    },
  };
}
