"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { actionSelector } = require("../utils");
const output = process.env.E2E_PROFILE_OUTPUT;
const { phase } = require("./harness");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function downloaded(predicate) {
  const directory = path.join(output, "downloads");
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const files = fs.readdirSync(directory);
    const file = files.find(predicate);
    if (file && !files.some(name => name.endsWith(".crdownload"))) return path.join(directory, file);
    await wait(100);
  }
  throw new Error("Download did not complete");
}
function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

module.exports = {
  "@disabled": !output,
  "Davros server profiling workflow": async function (browser) {
    browser.globals.waitForConditionTimeout = 180000;
    await phase("login", async () => { await browser.loginDevAccount("Profiler", true); });
    await browser.chrome.sendDevToolsCommand("Page.setDownloadBehavior", {
      behavior: "allow", downloadPath: path.join(output, "downloads"),
    });
    let appUrl;
    await phase("install", async () => {
      await browser.url(browser.launch_url + "/upload-test")
        .waitForElementVisible("#upload-app")
        .setValue("#upload-app", process.env.E2E_DAVROS_SPK)
        .waitForElementVisible(".install-step-confirm", 180000)
        .click(".confirm-install-button").waitForElementVisible(actionSelector, 180000)
        .disableGuidedTour();
      await browser.url(result => { appUrl = result.value; });
    });
    async function createGrain() {
      await browser.frame(null).url(appUrl).waitForElementVisible(actionSelector)
        .click(actionSelector).waitForElementVisible("#grainTitle", 180000)
        .grainFrame().waitForElementVisible("nav.sidebar", 180000)
        .waitForElementVisible(".file-list, .empty-notice", 180000);
    }
    await phase("create-grain-1", createGrain);
    // Five rendered page visits, ending in the directory where the transfer takes place.
    const pages = [["/", ".file-list, .empty-notice"], ["/clients", ".server-url"],
      ["/publishing", ".publishing"], ["/about", ".about"], ["/", ".file-list, .empty-notice"]];
    for (let i = 0; i < pages.length; i++) {
      const [href, ready] = pages[i];
      await phase(`browse-${i + 1}`, async () => {
        await browser.click(`nav.sidebar a[href="${href}"]`).waitForElementVisible(ready);
      });
    }
    await phase("upload", async () => {
      await browser.uploadFile('input[type="file"].upload-placeholder', path.join(output, "payload.bin"))
        .waitForElementVisible('tr[data-file-path="payload.bin"]', 180000)
        .waitForElementNotPresent(".upload-progress", 180000);
    });
    let file;
    await phase("download", async () => {
      // A same-origin download through the grain gateway, without buffering 50 MB in WebDriver.
      await browser.execute(function () {
        const link = document.createElement("a");
        link.href = "/dav/payload.bin"; link.download = "payload.bin";
        document.body.appendChild(link); link.click(); link.remove();
      });
      file = await downloaded(name => name === "payload.bin");
    });
    if (digest(file) !== digest(path.join(output, "payload.bin"))) throw new Error("Download hash mismatch");
    let backup;
    await phase("backup", async () => {
      await browser.frame(null).clickTopbarButton("#backupGrain");
      backup = await downloaded(name => name.endsWith(".zip"));
    });
    execFileSync("unzip", ["-t", backup]);
    const JSZip = require("jszip");
    const archive = await JSZip.loadAsync(fs.readFileSync(backup));
    const entry = Object.values(archive.files).find(item => !item.dir && item.name.endsWith("/payload.bin"));
    if (!entry || crypto.createHash("sha256").update(await entry.async("nodebuffer")).digest("hex") !== digest(file)) {
      throw new Error("Backup does not contain the uploaded payload");
    }
    fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify({
      payloadSha256: digest(file), backup, backupBytes: fs.statSync(backup).size, backupVerified: true,
    }, null, 2));
    for (let i = 2; i <= 6; i++) await phase(`create-grain-${i}`, createGrain);
    await browser.end();
  },
};
