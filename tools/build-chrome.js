// Makes the Chrome / Edge version of the add-on from extension/. The code is the same; only the package differs:
// - the background scripts run in a service worker (sw.js loads them with importScripts), as Chromium requires
// - Firefox-only manifest keys are left out
//
//   node tools/build-chrome.js      → dist/chrome/ (load it unpacked) and dist/tenno_trade_helper-chrome-<version>.zip

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NOT_SHIPPED = ['README.md', 'STORE_LISTING.md'];

function makeChromeVariant(srcDir, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(srcDir, outDir, { recursive: true });
  for (const f of NOT_SHIPPED) fs.rmSync(path.join(outDir, f), { force: true });
  const manifestFile = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const scripts = manifest.background.scripts;
  fs.writeFileSync(path.join(outDir, 'sw.js'),
    `'use strict';\n// Chrome/Edge: the same background scripts as Firefox, loaded into the service worker.\n/* global importScripts */\nimportScripts(${scripts.map((s) => `'${s}'`).join(', ')});\n`);
  manifest.background = { service_worker: 'sw.js' };
  delete manifest.browser_specific_settings;
  manifest.minimum_chrome_version = '120';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

module.exports = { makeChromeVariant };

if (require.main === module) {
  const out = path.join(ROOT, 'dist', 'chrome');
  const { version } = makeChromeVariant(path.join(ROOT, 'extension'), out);
  const zip = `tenno_trade_helper-chrome-${version}.zip`;
  execSync(`npx --no-install web-ext build --source-dir "${out}" --artifacts-dir "${path.join(ROOT, 'dist')}" --filename ${zip} --overwrite-dest`,
    { cwd: ROOT, stdio: 'ignore' });
  console.log(`Chrome / Edge package: dist/${zip} (unpacked: dist/chrome)`);
}
