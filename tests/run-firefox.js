// End-to-end test of the add-on in real Firefox (headless), against the fake warframe.market in mock-wfm.js.
//
// It builds a TEST variant of the add-on in a temp folder (API pointed at the mock, plus selftest.js, which
// clicks through the page from inside: WebDriver can't script extension pages), installs it, and does the
// website-side steps the self-test asks for (logging in/out on warframe.market by setting its cookie).
//
//   npm test                    (needs Firefox installed; set FIREFOX_BIN to use another Firefox-based browser)

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { startMock, TOKEN } = require('./mock-wfm');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3901;
const MOCK = `http://127.0.0.1:${PORT}`;
const WORK = path.join(os.tmpdir(), 'tenno-trade-helper-test');
const OUTPUT = path.join(__dirname, 'output');
const ADDON_ID = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
const UUID = '3b0d3d4f-0000-4000-8000-000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function patch(file, from, to) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`Test build: "${from}" not found in ${path.basename(file)}`);
  fs.writeFileSync(file, text.replace(from, to));
}

function buildTestVariant() {
  const src = path.join(WORK, 'src');
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'extension'), src, { recursive: true });
  patch(path.join(src, 'lib', 'backend.js'), "const API = 'https://api.warframe.market';", `const API = '${MOCK}'; // TEST BUILD`);
  patch(path.join(src, 'background.js'), "if (reason === 'install') browser.tabs.create({ url: APP_URL });",
    "if (reason === 'install') browser.tabs.create({ url: APP_URL + '?selftest' });");
  patch(path.join(src, 'app.html'), '<script src="scan.js"></script>', '<script src="scan.js"></script>\n  <script src="selftest.js"></script>');
  fs.copyFileSync(path.join(__dirname, 'selftest.js'), path.join(src, 'selftest.js'));
  const manifestFile = path.join(src, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*', '<all_urls>'); // the mock, and captureVisibleTab for screenshots
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  execSync(`npx --no-install web-ext build --source-dir "${src}" --artifacts-dir "${WORK}" --filename addon.zip --overwrite-dest`,
    { cwd: __dirname, stdio: 'ignore' });
  return path.join(WORK, 'addon.zip');
}

async function main() {
  const xpi = buildTestVariant();
  const mock = await startMock({
    port: PORT,
    fixturesDir: path.join(__dirname, 'fixtures'),
    outputDir: OUTPUT,
    onReport: (r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.extra ? `  (${r.extra.slice(0, 200)})` : ''}`),
  });

  const options = new firefox.Options()
    .addArguments('-headless')
    .windowSize({ width: 1600, height: 1300 })
    .setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: UUID }));
  if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
  // Selenium Manager finds Firefox and downloads a matching geckodriver automatically.
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();

  let timedOut = false;
  try {
    const first = await driver.getWindowHandle();
    await driver.installAddon(xpi, true);
    let appTab = null; // the add-on opens its page right after installing
    for (let i = 0; i < 40 && !appTab; i++) {
      await sleep(250);
      appTab = (await driver.getAllWindowHandles()).find((h) => h !== first) ?? null;
    }
    if (!appTab) throw new Error('The add-on did not open its page after installing.');

    const handled = new Set();
    const t0 = Date.now();
    while (!mock.phases.includes('done')) {
      if (Date.now() - t0 > 8 * 60 * 1000) { timedOut = true; break; }
      for (const p of mock.phases) {
        if (handled.has(p) || !['need-cookie', 'need-logout'].includes(p)) continue;
        handled.add(p);
        // "Log in / out on warframe.market": that's just the site's JWT cookie, set in another tab.
        await driver.switchTo().newWindow('tab');
        await driver.get('https://warframe.market/robots.txt');
        if (p === 'need-cookie') await driver.manage().addCookie({ name: 'JWT', value: TOKEN, path: '/', secure: true });
        else await driver.manage().deleteCookie('JWT');
        await driver.close();
        await driver.switchTo().window(appTab);
      }
      await sleep(300);
    }
  } finally {
    await driver.quit();
    mock.server.close();
  }

  const failed = mock.reports.filter((r) => !r.ok).length;
  console.log(`\n${mock.reports.length - failed} passed, ${failed} failed${timedOut ? ' (timed out)' : ''}. Screenshots: ${OUTPUT}`);
  process.exitCode = failed || timedOut || !mock.reports.length ? 1 : 0;
}

main().catch((err) => {
  console.error('Test run failed:', err.message);
  process.exitCode = 1;
});
