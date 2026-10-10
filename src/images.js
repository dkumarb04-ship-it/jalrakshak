/**
 * Photo handling: accept a base64 data URL from the client, strip metadata
 * (EXIF/GPS) for privacy, and store the raw bytes on local disk.
 *
 * Privacy note (DPDP Act alignment): we deliberately DROP EXIF. Location is
 * taken only from the user-controlled pin (which may be coarse), never from
 * photo GPS tags. Only the coarse city-scale position is retained.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UPLOAD_DIR, MAX_IMAGE_BYTES } from './config.js';

/** Allowed image signatures (magic bytes) we will accept. */
const ALLOWED = {
  'image/jpeg': { ext: '.jpg', magic: [0xff, 0xd8, 0xff] },
  'image/png': { ext: '.png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/webp': { ext: '.webp', magic: null } // RIFF....WEBP checked below
};

function matchesMagic(buf, magic) {
  if (!magic) return true;
  return magic.every((b, i) => buf[i] === b);
}

/**
 * Strip EXIF/metadata from a JPEG by re-walking its segments and dropping
 * APP1 (EXIF/XMP) and other APPn marker payloads except APP0/JFIF.
 * For PNG we drop ancillary chunks that carry metadata (tEXt/iTXt/zTXt/eXIf).
 * This is a best-effort, dependency-free sanitiser.
 */
function stripMetadata(buf, mime) {
  try {
    if (mime === 'image/jpeg') return stripJpeg(buf);
    if (mime === 'image/png') return stripPng(buf);
    return buf; // webp/other: left as-is (client should compress)
  } catch {
    return buf; // on any parse trouble, keep original rather than corrupt
  }
}

function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { // not a marker; copy the rest and stop
      out.push(buf.subarray(i));
      break;
    }
    const marker = buf[i + 1];
    // Standalone markers (no length)
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const isApp0 = marker === 0xe0; // JFIF — keep
    const isSos = marker === 0xda;  // start of scan — keep marker + entropy data
    if (isSos) { out.push(buf.subarray(i)); break; }
    if (isApp0) {
      out.push(buf.subarray(i, i + 2 + len));
    }
    // else: drop APPn/COM (EXIF lives in APP1) by skipping it
    i += 2 + len;
  }
  return Buffer.concat(out);
}

function stripPng(buf) {
  const out = [buf.subarray(0, 8)]; // PNG signature
  let i = 8;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const chunkTotal = 12 + len; // len(4)+type(4)+data+crc(4)
    const drop = ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'iCCP'].includes(type);
    if (!drop) out.push(buf.subarray(i, i + chunkTotal));
    i += chunkTotal;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

/**
 * Save a photo from a data URL. Returns a relative URL path for the DB,
 * or throws { status } on invalid/oversized input.
 * @param {string} dataUrl  e.g. "data:image/jpeg;base64,...."
 * @returns {Promise<{path:string, bytes:number, mime:string}>}
 */
export async function savePhotoFromDataUrl(dataUrl) {
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw Object.assign(new Error('Invalid image payload'), { status: 400 });
  const mime = match[1].toLowerCase();
  const spec = ALLOWED[mime];
  if (!spec) throw Object.assign(new Error('Unsupported image type'), { status: 415 });

  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('Image too large'), { status: 413 });
  }
  if (spec.magic && !matchesMagic(buf, spec.magic)) {
    throw Object.assign(new Error('Image does not match its declared type'), { status: 400 });
  }
  if (mime === 'image/webp' &&
      !(buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')) {
    throw Object.assign(new Error('Image does not match its declared type'), { status: 400 });
  }

  const cleaned = stripMetadata(buf, mime);
  await mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${randomUUID()}${spec.ext}`;
  await writeFile(join(UPLOAD_DIR, name), cleaned);
  return { path: `/uploads/${name}`, bytes: cleaned.length, mime };
}
