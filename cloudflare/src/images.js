/**
 * Photo handling for the Cloudflare Worker (port of src/images.js).
 *
 * Accepts a base64 data URL, strips EXIF/GPS metadata for privacy, and stores
 * the cleaned bytes in D1 (base64) rather than the filesystem / R2, so it works
 * on no-login temporary deploys which do not provision R2.
 *
 * Privacy note (DPDP Act alignment): we deliberately DROP EXIF. Location comes
 * only from the user-controlled pin, never from photo GPS tags.
 */
import { savePhoto } from './store.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB, matches src/config.js

const ALLOWED = {
  'image/jpeg': { ext: '.jpg', magic: [0xff, 0xd8, 0xff] },
  'image/png': { ext: '.png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/webp': { ext: '.webp', magic: null }
};

const matchesMagic = (buf, magic) => !magic || magic.every((b, i) => buf[i] === b);

function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { out.push(buf.subarray(i)); break; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(i, i + 2)); i += 2; continue;
    }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    const isApp0 = marker === 0xe0;
    if (marker === 0xda) { out.push(buf.subarray(i)); break; }
    if (isApp0) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return concatBytes(out);
}

function stripPng(buf) {
  const out = [buf.subarray(0, 8)];
  let i = 8;
  while (i < buf.length) {
    const len = ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0;
    const type = String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]);
    const chunkTotal = 12 + len;
    const drop = ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'iCCP'].includes(type);
    if (!drop) out.push(buf.subarray(i, i + chunkTotal));
    i += chunkTotal;
    if (type === 'IEND') break;
  }
  return concatBytes(out);
}

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function stripMetadata(buf, mime) {
  try {
    if (mime === 'image/jpeg') return stripJpeg(buf);
    if (mime === 'image/png') return stripPng(buf);
    return buf;
  } catch { return buf; }
}

/**
 * Save a photo from a data URL into D1. Returns a relative URL path.
 * @param {object} db D1 binding
 * @param {string} dataUrl "data:image/jpeg;base64,...."
 * @returns {Promise<{path:string, bytes:number, mime:string}>}
 */
export async function savePhotoFromDataUrl(db, dataUrl) {
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw Object.assign(new Error('Invalid image payload'), { status: 400 });
  const mime = match[1].toLowerCase();
  const spec = ALLOWED[mime];
  if (!spec) throw Object.assign(new Error('Unsupported image type'), { status: 415 });

  const binary = atob(match[2]);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);

  if (buf.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('Image too large'), { status: 413 });
  }
  if (spec.magic && !matchesMagic(buf, spec.magic)) {
    throw Object.assign(new Error('Image does not match its declared type'), { status: 400 });
  }
  if (mime === 'image/webp' &&
      !(buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)) {
    throw Object.assign(new Error('Image does not match its declared type'), { status: 400 });
  }

  const cleaned = stripMetadata(buf, mime);
  let cleanedB64;
  let cleanedLen = cleaned.length;
  // btoa needs a binary string; chunk to avoid call-stack limits on large arrays.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < cleaned.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, cleaned.subarray(i, i + CHUNK));
  }
  cleanedB64 = btoa(bin);
  return savePhoto(db, mime, cleanedB64, cleanedLen);
}
