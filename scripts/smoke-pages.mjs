import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/curvilinear-mesh-layer/';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 180000);

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-gl=swiftshader'],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    const failedUrl = request.url();
    if (!failedUrl.includes('tile.openstreetmap.org')) {
      errors.push(`${failedUrl}: ${request.failure()?.errorText ?? 'request failed'}`);
    }
  });

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#map');
  await page.waitForSelector('#loadBtn');

  // The service worker may reload once to enable SharedArrayBuffer isolation.
  await page.waitForFunction(() => window.crossOriginIsolated === true, null, {
    timeout: 45000,
  });

  await page.click('#loadBtn');
  await page.waitForSelector('#status', { state: 'visible' });
  await page.waitForFunction(
    () => {
      const status = document.getElementById('status');
      if (!status) return true;
      if (status.classList.contains('error')) {
        throw new Error(status.textContent.trim());
      }
      return status.style.display === 'none' || status.textContent.trim() === '';
    },
    null,
    { timeout: timeoutMs },
  );

  if (errors.length) {
    throw new Error(errors.slice(0, 5).join('\n'));
  }

  console.log(`Smoke test passed: ${url}`);
} finally {
  await browser.close();
}
