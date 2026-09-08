import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * libGD.js provisioning pin. Mirrors `newIDE/app/scripts/import-libGD.js`:
 * prebuilt artifacts live under
 * `https://s3.amazonaws.com/gdevelop-gdevelop.js/{branch}/commit/{hash}`
 * with a `{branch}/latest` fallback, each exposing `libGD.js` + `libGD.wasm`.
 */

const S3_BASE = 'https://s3.amazonaws.com/gdevelop-gdevelop.js';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const libgdPinSchema = z.object({
  branch: z.string().min(1),
  commit: z.string().min(1).nullable(),
  sha256: z
    .object({
      libGDJs: sha256Hex,
      libGDWasm: sha256Hex,
    })
    .nullable(),
});

export type LibgdPin = z.infer<typeof libgdPinSchema>;

export function parseLibgdPin(raw: unknown): LibgdPin {
  return libgdPinSchema.parse(raw);
}

export interface LibgdDownloadUrls {
  baseUrl: string;
  jsUrl: string;
  wasmUrl: string;
}

export function buildLibgdDownloadUrls(pin: LibgdPin): LibgdDownloadUrls {
  const baseUrl = pin.commit === null ? `${S3_BASE}/${pin.branch}/latest` : `${S3_BASE}/${pin.branch}/commit/${pin.commit}`;
  return {
    baseUrl,
    jsUrl: `${baseUrl}/libGD.js`,
    wasmUrl: `${baseUrl}/libGD.wasm`,
  };
}

export function verifySha256Hex(data: Uint8Array, expectedHex: string): boolean {
  const actual = createHash('sha256').update(data).digest('hex');
  return actual === expectedHex.toLowerCase();
}
