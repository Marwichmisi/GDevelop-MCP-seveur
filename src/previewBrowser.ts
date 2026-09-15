import { createRequire } from 'node:module';
import { join } from 'node:path';
import { McpError } from './errors.js';
import type { PreviewBrowser, PreviewCaptureOptions } from './preview.js';

/**
 * Headless-browser capture for playable previews (issue #16, research §4.2).
 *
 * `puppeteer` is an `optionalDependencies` (~150 Mo Chromium): never imported
 * statically, only resolved at screenshot time via `createRequire`, with a
 * clean `preview-puppeteer-unavailable` refusal when absent. The fast
 * log-only path never touches this module.
 */

interface ConsoleMessage {
  type(): string;
  text(): string;
}

interface PuppeteerPage {
  on(event: string, handler: (...args: never[]) => void): void;
  setViewport(viewport: { width: number; height: number }): Promise<void>;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<void>;
  screenshot(options: { path: string; type: string }): Promise<void>;
}

interface PuppeteerBrowserHandle {
  newPage(): Promise<PuppeteerPage>;
  close(): Promise<void>;
}

function resolvePuppeteer(): unknown {
  // Primary path: the declared `optionalDependencies` entry. Fallback:
  // `puppeteer-core` driving a system Chrome (docker images, slow networks).
  try {
    const require = createRequire(import.meta.url);
    try {
      return require('puppeteer');
    } catch {
      return require('puppeteer-core');
    }
  } catch {
    return null;
  }
}

export function isPuppeteerAvailable(): boolean {
  return resolvePuppeteer() !== null;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PuppeteerBrowser implements PreviewBrowser {
  async capture(
    url: string,
    options: PreviewCaptureOptions,
  ): Promise<{ logs: string[]; pageErrors: string[]; screenshotPath: string | null }> {
    const puppeteer = resolvePuppeteer() as {
      launch(options: { headless: boolean; executablePath?: string; args: string[] }): Promise<PuppeteerBrowserHandle>;
    } | null;
    if (!puppeteer) {
      throw new McpError(
        'preview-puppeteer-unavailable',
        'Screenshot requested but the optional puppeteer dependency is not installed. Re-run with withScreenshot:false, or `npm install --no-save puppeteer` (bundled Chromium) or `puppeteer-core` + `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome`.',
      );
    }
    const logs: string[] = [];
    const pageErrors: string[] = [];
    // `PUPPETEER_EXECUTABLE_PATH` (system Chrome, docker) overrides the
    // bundled Chromium; `--no-sandbox` is required as root/in containers and
    // is acceptable because the browser only ever opens 127.0.0.1 previews.
    const executablePath = process.env['PUPPETEER_EXECUTABLE_PATH'];
    let browser: PuppeteerBrowserHandle;
    try {
      browser = await puppeteer.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    } catch (error) {
      // No usable browser binary (bundled Chromium never downloaded and no
      // system Chrome): stay on the clean opt-in refusal instead of leaking
      // a raw launcher error. Keeps unit tests hermetic whatever the host
      // happens to have installed.
      if (error instanceof Error && /could not find chrome|chrome.*not found|no usable sandbox|executable|ENOENT/i.test(error.message)) {
        throw new McpError(
          'preview-puppeteer-unavailable',
          `Screenshot requested but no usable browser binary was found (${error.message.split('\n')[0]}). Re-run with withScreenshot:false, or install the full puppeteer package, or set PUPPETEER_EXECUTABLE_PATH to a system Chrome.`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      const page = await browser.newPage();
      page.on('console', (message: unknown) => {
        const typed = message as ConsoleMessage;
        try {
          logs.push(`[${typed.type()}] ${typed.text()}`);
        } catch {
          logs.push('[log] (unreadable console message)');
        }
      });
      page.on('pageerror', (error: unknown) => {
        pageErrors.push(error instanceof Error ? error.message : String(error));
      });
      await page.setViewport({ width: options.width, height: options.height });
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      if (options.durationMs > 0) await delay(options.durationMs);
      let screenshotPath: string | null = null;
      if (options.withScreenshot) {
        screenshotPath = join(options.outDir, 'screenshot.png');
        await page.screenshot({ path: screenshotPath, type: 'png' });
      }
      return { logs, pageErrors, screenshotPath };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}
