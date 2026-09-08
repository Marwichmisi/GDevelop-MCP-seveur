import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildLibgdDownloadUrls, parseLibgdPin, verifySha256Hex } from '../src/libgdPin.js';

describe('libGD provisioning pin', () => {
  it('builds the S3 commit-pinned URLs for both artifacts', () => {
    const pin = parseLibgdPin({
      branch: 'master',
      commit: 'abc123',
      sha256: { libGDJs: 'a'.repeat(64), libGDWasm: 'b'.repeat(64) },
    });
    const urls = buildLibgdDownloadUrls(pin);
    assert.equal(urls.jsUrl, 'https://s3.amazonaws.com/gdevelop-gdevelop.js/master/commit/abc123/libGD.js');
    assert.equal(urls.wasmUrl, 'https://s3.amazonaws.com/gdevelop-gdevelop.js/master/commit/abc123/libGD.wasm');
  });

  it('falls back to the branch latest build when no commit is pinned', () => {
    const pin = parseLibgdPin({ branch: 'master', commit: null, sha256: null });
    const urls = buildLibgdDownloadUrls(pin);
    assert.equal(urls.jsUrl, 'https://s3.amazonaws.com/gdevelop-gdevelop.js/master/latest/libGD.js');
  });

  it('rejects a pin with a malformed sha256', () => {
    assert.throws(() =>
      parseLibgdPin({ branch: 'master', commit: 'abc123', sha256: { libGDJs: 'nope', libGDWasm: 'b'.repeat(64) } }),
    );
  });

  it('verifies artifact bytes against the pinned hash', () => {
    const data = Buffer.from('fake-wasm-bytes');
    const hex = createHash('sha256').update(data).digest('hex');
    assert.equal(verifySha256Hex(data, hex), true);
    assert.equal(verifySha256Hex(data, '0'.repeat(64)), false);
  });
});
