#!/usr/bin/env node
/**
 * Download the pinned prebuilt libGD.js + libGD.wasm from S3 into vendor/.
 * Pin file: vendor/libgd-pin.json ({branch, commit, sha256}). When the pin
 * carries no commit, the branch latest build is fetched; when it carries no
 * sha256, hashes are recorded to stdout so they can be pasted into the pin.
 *
 * Requires `npm run build` first (URL/hash helpers live in dist/).
 * Env overrides: GDEVELOP_LIBGD_PIN (pin file path), GDEVELOP_VENDOR_DIR.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = process.env['GDEVELOP_VENDOR_DIR'] ?? join(here, '..', 'vendor');
const pinPath = process.env['GDEVELOP_LIBGD_PIN'] ?? join(vendorDir, 'libgd-pin.json');

let helpers;
try {
  helpers = await import('../dist/src/libgdPin.js');
} catch {
  console.error('Missing dist/src/libgdPin.js — run `npm run build` first (it needs no libGD).');
  process.exit(1);
}
const { parseLibgdPin, buildLibgdDownloadUrls, verifySha256Hex } = helpers;

const pin = parseLibgdPin(JSON.parse(readFileSync(pinPath, 'utf8')));
const urls = buildLibgdDownloadUrls(pin);
console.log(`Base URL: ${urls.baseUrl}`);

async function download(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      console.log(`Attempt ${attempt}/${attempts} failed (${error.cause?.code ?? error.message}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw lastError;
}

mkdirSync(vendorDir, { recursive: true });
for (const [label, url, file, expected] of [
  ['libGD.js', urls.jsUrl, join(vendorDir, 'libGD.js'), pin.sha256?.libGDJs ?? null],
  ['libGD.wasm', urls.wasmUrl, join(vendorDir, 'libGD.wasm'), pin.sha256?.libGDWasm ?? null],
]) {
  console.log(`Downloading ${label} ...`);
  const bytes = await download(url);
  if (expected && !verifySha256Hex(bytes, expected)) {
    throw new Error(`SHA256 mismatch for ${label}; refusing to write.`);
  }
  writeFileSync(file, bytes);
  const { createHash } = await import('node:crypto');
  console.log(`Wrote ${file} (${bytes.length} bytes, sha256=${createHash('sha256').update(bytes).digest('hex')})`);
}
console.log('Done.');
