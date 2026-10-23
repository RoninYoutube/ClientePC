'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [
  'src/galaxy-client.js',
  'src/galaxy-http.js',
  'src/proxy.js',
  'go-sidecar/main.go'
];

const chromeVersions = [];

for (const file of files) {
  const fullPath = path.join(root, file);
  const source = fs.readFileSync(fullPath, 'utf8');
  for (const match of source.matchAll(/\b(?:Chrome\/|chrome )(\d+)\.0\.0\.0\b/g)) {
    chromeVersions.push({ file, version: match[1], value: match[0] });
  }
}

const distinctChromeVersions = new Set(chromeVersions.map((item) => item.version));
if (distinctChromeVersions.size !== 1) {
  console.error('[fingerprint] Versiones Chrome inconsistentes:');
  for (const item of chromeVersions) {
    console.error(`  ${item.file}: ${item.value}`);
  }
  process.exit(1);
}

const galaxyClient = fs.readFileSync(path.join(root, 'src/galaxy-client.js'), 'utf8');
if (!/headers:\s*WS_HANDSHAKE_HEADERS/.test(galaxyClient)) {
  console.error('[fingerprint] El WebSocket del sidecar no esta usando WS_HANDSHAKE_HEADERS.');
  process.exit(1);
}

const sidecar = fs.readFileSync(path.join(root, 'go-sidecar/main.go'), 'utf8');
if (!/parseHeadersFromQuery/.test(sidecar)) {
  console.error('[fingerprint] El sidecar no acepta headers enviados por Node.');
  process.exit(1);
}

console.log(`[fingerprint] Chrome visible consistente: ${[...distinctChromeVersions][0]}.0.0.0`);
