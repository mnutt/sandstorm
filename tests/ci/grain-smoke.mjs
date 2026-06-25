import { chromium } from "playwright-core";

const baseUrl = process.env.SANDSTORM_SMOKE_BASE_URL || "http://local.sandstorm.io:6080";
const chromePath = process.env.CHROME_PATH;
const testApp = {
  packageId: "ca690ad886bf920026f8b876c19539c1",
  appId: "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh",
  url: "https://dl.sandstorm.org/testapps/ssjekyll8.spk",
};

if (!chromePath) {
  throw new Error("CHROME_PATH must point to a Chrome/Chromium executable.");
}

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--host-resolver-rules=MAP local.sandstorm.io 127.0.0.1,MAP *.local.sandstorm.io 127.0.0.1",
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
  page.setDefaultTimeout(120000);

  console.log(`Opening ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  console.log("Logging in with a dev account");
  await page.waitForFunction(() => typeof window.loginDevAccountFast === "function");
  await page.evaluate(async () => {
    await window.loginDevAccountFast("cismoketest", false);
  });

  console.log("Installing test app package");
  await page.goto(`${baseUrl}/install/${testApp.packageId}?url=${testApp.url}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#step-confirm", { state: "visible" });
  await page.click("#confirmInstall");

  console.log("Starting a grain");
  await page.evaluate(() => {
    Session.set("dismissedGrainTableGuidedTour", true);
    Session.set("dismissedInstallHint", true);
    Meteor._localStorage.removeItem("userNeedsShareAccessHint");
  });
  await page.goto(`${baseUrl}/apps`, { waitUntil: "domcontentloaded" });
  await page.click(`.app-list>.app-button[data-app-id="${testApp.appId}"]`);
  await page.waitForSelector(".grain-list-table tr.action button.action", { state: "visible" });
  await page.click(".grain-list-table tr.action button.action");
  await page.waitForURL(/\/grain\/\w+/, { timeout: 120000 });
  await page.waitForSelector("#grainTitle", { state: "visible" });
  await page.waitForSelector("iframe.grain-frame", { state: "visible" });

  const grainUrl = page.url();
  const title = await page.locator("#grainTitle").textContent();
  console.log(`Grain started: ${grainUrl} (${title?.trim() || "untitled"})`);
} finally {
  await browser.close();
}
