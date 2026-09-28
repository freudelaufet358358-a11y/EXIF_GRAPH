// Minimal, read-only EXIF extractor for the browser (and Node >= 20 via Blob).
// It reads only the byte ranges it needs through Blob.slice(), so thousands of
// large RAW files can be scanned without loading whole files into memory.
//
// Supported containers:
//   JPEG (APP1 Exif), TIFF and TIFF-based RAW (DNG, CR2, NEF, NRW, ARW, SR2,
//   ORF, RW2, PEF, SRW, 3FR, ERF, IIQ, ...), HEIF/HEIC/AVIF, Canon CR3,
//   Fujifilm RAF (embedded JPEG), PNG (eXIf chunk), WebP (EXIF chunk).

const HEAD_SIZE = 64 * 1024;

// Tags we care about. IFD0 and the Exif sub-IFD are merged, so TIFF/EP style
// RAW files that keep exposure tags in IFD0 work as well.
export const TAG = {
  JpgFromRaw: 0x002e, // Panasonic RW2 keeps a full JPEG (with Exif) here
  Make: 0x010f,
  Model: 0x0110,
  DateTime: 0x0132,
  ExposureTime: 0x829a,
  FNumber: 0x829d,
  ExifIFD: 0x8769,
  ExposureProgram: 0x8822,
  ISO: 0x8827,
  RecommendedExposureIndex: 0x8832,
  DateTimeOriginal: 0x9003,
  DateTimeDigitized: 0x9004,
  ShutterSpeedValue: 0x9201,
  ApertureValue: 0x9202,
  ExposureBiasValue: 0x9204,
  Flash: 0x9209,
  FocalLength: 0x920a,
  FocalLengthIn35mmFilm: 0xa405,
  LensSpecification: 0xa432,
  LensModel: 0xa434,
  DNGLensInfo: 0xc630,
};
const WANTED = new Set(Object.values(TAG));

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

const CR3_UUID = '85c0b687820f11e08111f4ce462b6a48';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

class Source {
  constructor(blob) {
    this.blob = blob;
    this.size = blob.size;
    this.head = null;
  }

  async init() {
    const len = Math.min(HEAD_SIZE, this.size);
    this.head = new Uint8Array(await this.blob.slice(0, len).arrayBuffer());
  }

  // DataView over [offset, offset + length): served from the cached head when
  // possible, otherwise sliced from the blob.
  async view(offset, length) {
    if (!(offset >= 0) || !(length >= 0) || offset + length > this.size) {
      throw new RangeError('read outside file');
    }
    if (offset + length <= this.head.length) {
      return new DataView(this.head.buffer, this.head.byteOffset + offset, length);
    }
    const buf = await this.blob.slice(offset, offset + length).arrayBuffer();
    return new DataView(buf);
  }
}

function ascii(dv, off, len) {
  let s = '';
  for (let i = 0; i < len && off + i < dv.byteLength; i++) {
    s += String.fromCharCode(dv.getUint8(off + i));
  }
  return s;
}

function isTiffOrder(v) {
  return v === 0x4949 || v === 0x4d4d;
}

function scanForTiff(dv, from) {
  for (let i = from; i + 4 <= dv.byteLength; i++) {
    const a = dv.getUint32(i);
    if (a === 0x49492a00 || a === 0x4d4d002a) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- TIFF / IFD

async function readTiff(src, base, out) {
  const hdr = await src.view(base, 8);
  const order = hdr.getUint16(0);
  if (!isTiffOrder(order)) throw new Error('bad TIFF byte order');
  const le = order === 0x4949;
  // 42 = TIFF, 0x4f52 / 0x5352 = Olympus ORF, 0x55 = Panasonic RW2.
  const magic = hdr.getUint16(2, le);
  if (![42, 0x4f52, 0x5352, 0x55].includes(magic)) throw new Error('bad TIFF magic');
  await readIfd(src, base, hdr.getUint32(4, le), le, out, new Set());
}

async function readIfd(src, base, ifdOff, le, out, seen) {
  if (!ifdOff || seen.has(ifdOff) || seen.size > 8) return;
  seen.add(ifdOff);
  const at = base + ifdOff;
  const count = (await src.view(at, 2)).getUint16(0, le);
  if (count === 0 || count > 1000) return;
  const dv = await src.view(at + 2, count * 12);
  const subIfds = [];
  for (let i = 0; i < count; i++) {
    const e = i * 12;
    const tag = dv.getUint16(e, le);
    if (!WANTED.has(tag)) continue;
    const type = dv.getUint16(e + 2, le);
    const n = dv.getUint32(e + 4, le);
    const size = TYPE_SIZE[type] || 0;
    if (!size || n === 0) continue;
    const total = n * size;
    if (tag === TAG.ExifIFD) {
      subIfds.push(dv.getUint32(e + 8, le));
      continue;
    }
    if (tag === TAG.JpgFromRaw) {
      if (total > 4) out.__jpgFromRaw = base + dv.getUint32(e + 8, le);
      continue;
    }
    if (total > 4096) continue;
    let vdv = dv;
    let voff = e + 8;
    if (total > 4) {
      try {
        vdv = await src.view(base + dv.getUint32(e + 8, le), total);
      } catch {
        continue;
      }
      voff = 0;
    }
    const val = decodeValue(vdv, voff, type, n, le);
    // Sub-IFDs are read after IFD0, so Exif IFD values win over duplicates.
    if (val != null) out[tag] = val;
  }
  for (const sub of subIfds) {
    try {
      await readIfd(src, base, sub, le, out, seen);
    } catch {
      // A broken sub-IFD should not throw away what IFD0 already gave us.
    }
  }
}

function decodeValue(dv, off, type, n, le) {
  const list = (step, get) => {
    const a = [];
    for (let i = 0; i < n; i++) a.push(get(off + i * step));
    return n === 1 ? a[0] : a;
  };
  switch (type) {
    case 2: {
      const bytes = [];
      for (let i = 0; i < n; i++) {
        const c = dv.getUint8(off + i);
        if (c === 0) break;
        bytes.push(c);
      }
      let s;
      try {
        // Exif ASCII is nominally 7-bit, but UTF-8 shows up in the wild.
        s = UTF8.decode(new Uint8Array(bytes));
      } catch {
        s = String.fromCharCode(...bytes);
      }
      return s.trim() || null;
    }
    case 1:
    case 7:
      return n === 1 ? dv.getUint8(off) : null;
    case 3:
      return list(2, (p) => dv.getUint16(p, le));
    case 4:
      return list(4, (p) => dv.getUint32(p, le));
    case 8:
      return list(2, (p) => dv.getInt16(p, le));
    case 9:
      return list(4, (p) => dv.getInt32(p, le));
    case 5:
    case 10:
      return list(8, (p) => {
        const num = type === 5 ? dv.getUint32(p, le) : dv.getInt32(p, le);
        const den = type === 5 ? dv.getUint32(p + 4, le) : dv.getInt32(p + 4, le);
        return den === 0 ? null : num / den;
      });
    case 11:
      return list(4, (p) => dv.getFloat32(p, le));
    case 12:
      return list(8, (p) => dv.getFloat64(p, le));
    default:
      return null;
  }
}

// ---------------------------------------------------------------- JPEG

async function readJpeg(src, start, out) {
  if ((await src.view(start, 2)).getUint16(0) !== 0xffd8) return false;
  let pos = start + 2;
  for (let guard = 0; guard < 64 && pos + 4 <= src.size; guard++) {
    const m = await src.view(pos, 4);
    if (m.getUint8(0) !== 0xff) return false;
    const marker = m.getUint8(1);
    if (marker === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return false; // EOI / start of scan
    const len = m.getUint16(2);
    if (marker === 0xe1 && len >= 16) {
      const h = await src.view(pos + 4, 6);
      if (ascii(h, 0, 6) === 'Exif\0\0') {
        await readTiff(src, pos + 10, out);
        return true;
      }
    }
    pos += 2 + len;
  }
  return false;
}

// ---------------------------------------------------------------- ISOBMFF

async function* boxes(src, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    const h = await src.view(pos, 8);
    let size = h.getUint32(0);
    const type = ascii(h, 4, 4);
    let header = 8;
    if (size === 1) {
      size = Number((await src.view(pos + 8, 8)).getBigUint64(0));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) return;
    yield { type, start: pos, header, end: Math.min(pos + size, end) };
    pos += size;
  }
}

function readUint(dv, off, bytes) {
  if (bytes === 0) return 0;
  if (bytes === 4) return dv.getUint32(off);
  if (bytes === 8) return Number(dv.getBigUint64(off));
  throw new Error('bad iloc field size');
}

async function readHeif(src, out) {
  let meta = null;
  for await (const b of boxes(src, 0, src.size)) {
    if (b.type === 'meta') {
      meta = b;
      break;
    }
  }
  if (!meta) return false;
  let exifId = null;
  let iloc = null;
  let idat = null;
  // meta is a full box: skip version + flags.
  for await (const b of boxes(src, meta.start + meta.header + 4, meta.end)) {
    if (b.type === 'iinf') exifId = await findExifItem(src, b);
    else if (b.type === 'iloc') iloc = b;
    else if (b.type === 'idat') idat = b;
  }
  if (exifId == null || !iloc) return false;
  const loc = await findItemLocation(src, iloc, exifId);
  if (!loc) return false;
  let offset = loc.offset;
  if (loc.method === 1) {
    if (!idat) return false;
    offset += idat.start + idat.header;
  } else if (loc.method !== 0) {
    return false;
  }
  const dv = await src.view(offset, Math.min(64, src.size - offset));
  // Exif item payload: a 4-byte offset to the TIFF header, then the data
  // (normally "Exif\0\0" followed by the TIFF header).
  let tiff = offset + 4 + dv.getUint32(0);
  if (tiff + 8 > src.size || !isTiffOrder((await src.view(tiff, 2)).getUint16(0))) {
    const found = scanForTiff(dv, 0);
    if (found < 0) return false;
    tiff = offset + found;
  }
  await readTiff(src, tiff, out);
  return true;
}

async function findExifItem(src, iinf) {
  const version = (await src.view(iinf.start + iinf.header, 1)).getUint8(0);
  const entriesStart = iinf.start + iinf.header + 4 + (version === 0 ? 2 : 4);
  for await (const b of boxes(src, entriesStart, iinf.end)) {
    if (b.type !== 'infe') continue;
    const dv = await src.view(b.start + b.header, Math.min(16, b.end - b.start - b.header));
    const v = dv.getUint8(0);
    if (v < 2) continue;
    const id = v === 2 ? dv.getUint16(4) : dv.getUint32(4);
    if (ascii(dv, v === 2 ? 8 : 10, 4) === 'Exif') return id;
  }
  return null;
}

async function findItemLocation(src, iloc, itemId) {
  const dv = await src.view(iloc.start + iloc.header, iloc.end - iloc.start - iloc.header);
  const version = dv.getUint8(0);
  const s1 = dv.getUint8(4);
  const s2 = dv.getUint8(5);
  const offsetSize = s1 >> 4;
  const lengthSize = s1 & 15;
  const baseOffsetSize = s2 >> 4;
  const indexSize = version === 1 || version === 2 ? s2 & 15 : 0;
  let p = 6;
  const count = version < 2 ? dv.getUint16(p) : dv.getUint32(p);
  p += version < 2 ? 2 : 4;
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? dv.getUint16(p) : dv.getUint32(p);
    p += version < 2 ? 2 : 4;
    let method = 0;
    if (version === 1 || version === 2) {
      method = dv.getUint16(p) & 15;
      p += 2;
    }
    p += 2; // data_reference_index
    const baseOffset = readUint(dv, p, baseOffsetSize);
    p += baseOffsetSize;
    const extents = dv.getUint16(p);
    p += 2;
    let firstExtent = null;
    for (let e = 0; e < extents; e++) {
      p += indexSize;
      const eo = readUint(dv, p, offsetSize);
      p += offsetSize;
      p += lengthSize;
      if (firstExtent == null) firstExtent = eo;
    }
    if (id === itemId && firstExtent != null) {
      return { offset: baseOffset + firstExtent, method };
    }
  }
  return null;
}

async function readCr3(src, out) {
  for await (const b of boxes(src, 0, src.size)) {
    if (b.type !== 'moov') continue;
    for await (const c of boxes(src, b.start + b.header, b.end)) {
      if (c.type !== 'uuid') continue;
      const u = await src.view(c.start + c.header, 16);
      let hex = '';
      for (let i = 0; i < 16; i++) hex += u.getUint8(i).toString(16).padStart(2, '0');
      if (hex !== CR3_UUID) continue;
      // CMT1 = IFD0, CMT2 = Exif IFD; each is a complete TIFF structure.
      let found = false;
      for await (const d of boxes(src, c.start + c.header + 16, c.end)) {
        if (d.type === 'CMT1' || d.type === 'CMT2') {
          await readTiff(src, d.start + d.header, out);
          found = true;
        }
      }
      return found;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------- others

async function readRaf(src, out) {
  // Big-endian offset of the embedded full-size JPEG lives at byte 84.
  const off = (await src.view(84, 4)).getUint32(0);
  if (!off || off + 4 >= src.size) return false;
  return readJpeg(src, off, out);
}

async function readPng(src, out) {
  let pos = 8;
  for (let guard = 0; guard < 512 && pos + 8 <= src.size; guard++) {
    const h = await src.view(pos, 8);
    const len = h.getUint32(0);
    const type = ascii(h, 4, 4);
    if (type === 'eXIf') {
      await readTiff(src, pos + 8, out);
      return true;
    }
    if (type === 'IEND') return false;
    pos += 12 + len;
  }
  return false;
}

async function readWebp(src, out) {
  let pos = 12;
  for (let guard = 0; guard < 64 && pos + 8 <= src.size; guard++) {
    const h = await src.view(pos, 8);
    const type = ascii(h, 0, 4);
    const len = h.getUint32(4, true);
    if (type === 'EXIF') {
      const d = await src.view(pos + 8, Math.min(len, 16));
      const at = scanForTiff(d, 0);
      if (at < 0) return false;
      await readTiff(src, pos + 8 + at, out);
      return true;
    }
    pos += 8 + len + (len & 1);
  }
  return false;
}

// ---------------------------------------------------------------- entry

// Reads raw tag values keyed by numeric tag id, or null when the file has no
// Exif block we can find.
export async function readRawTags(blob) {
  const src = new Source(blob);
  await src.init();
  const h = src.head;
  if (h.length < 16) return null;
  const dv = new DataView(h.buffer, h.byteOffset, h.length);
  const out = {};

  let ok = false;
  try {
    const a = dv.getUint16(0);
    if (a === 0xffd8) {
      ok = await readJpeg(src, 0, out);
    } else if (isTiffOrder(a)) {
      await readTiff(src, 0, out);
      ok = true;
      if (out[TAG.FNumber] == null && out[TAG.ExposureTime] == null && out.__jpgFromRaw) {
        // Panasonic RW2: the complete Exif lives in the embedded JPEG.
        const extra = {};
        try {
          if (await readJpeg(src, out.__jpgFromRaw, extra)) {
            for (const k of Object.keys(extra)) if (!(k in out)) out[k] = extra[k];
          }
        } catch {
          /* keep what IFD0 gave us */
        }
      }
    } else if (ascii(dv, 4, 4) === 'ftyp') {
      ok = ascii(dv, 8, 4) === 'crx ' ? await readCr3(src, out) : await readHeif(src, out);
    } else if (ascii(dv, 0, 15) === 'FUJIFILMCCD-RAW') {
      ok = await readRaf(src, out);
    } else if (dv.getUint32(0) === 0x89504e47) {
      ok = await readPng(src, out);
    } else if (ascii(dv, 0, 4) === 'RIFF' && ascii(dv, 8, 4) === 'WEBP') {
      ok = await readWebp(src, out);
    }
  } catch {
    ok = false;
  }

  if (!ok) {
    // Last resort: an "Exif\0\0" marker followed by a TIFF header in the head.
    for (let i = 0; i + 14 < h.length && !ok; i++) {
      if (h[i] === 0x45 && h[i + 1] === 0x78 && h[i + 2] === 0x69 && h[i + 3] === 0x66 &&
          h[i + 4] === 0 && h[i + 5] === 0 && isTiffOrder(dv.getUint16(i + 6))) {
        try {
          await readTiff(src, i + 6, out);
          ok = true;
        } catch {
          /* keep scanning */
        }
      }
    }
  }
  delete out.__jpgFromRaw;
  return ok && Object.keys(out).length ? out : null;
}

function num(v) {
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseExifDate(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [y, mo, d, hh, mi, ss] = m.slice(1).map((x) => (x == null ? 0 : Number(x)));
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59) return null;
  // Camera wall-clock time, stored as a UTC timestamp so it never shifts
  // with the viewer's time zone. Read it back with getUTC*().
  return Date.UTC(y, mo - 1, d, hh, mi, ss || 0);
}

export function formatLensSpec(spec) {
  if (!Array.isArray(spec) || spec.length < 4) return null;
  const [minF, maxF, minA, maxA] = spec.map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0));
  if (!(minF > 0)) return null;
  const r = (x) => String(Math.round(x * 10) / 10);
  const f = !maxF || minF === maxF ? `${r(minF)}mm` : `${r(minF)}-${r(maxF)}mm`;
  if (!(minA > 0)) return f;
  const a = !maxA || minA === maxA ? `F${r(minA)}` : `F${r(minA)}-${r(maxA)}`;
  return `${f} ${a}`;
}

const MAKE_ALIASES = [
  [/^NIKON/i, 'Nikon'],
  [/^OLYMPUS/i, 'OLYMPUS'],
  [/^OM Digital/i, 'OM SYSTEM'],
  [/^PENTAX/i, 'PENTAX'],
  [/^RICOH/i, 'RICOH'],
  [/^EASTMAN KODAK/i, 'Kodak'],
  [/^SAMSUNG/i, 'Samsung'],
  [/^Panasonic/i, 'Panasonic'],
  [/^SONY/i, 'Sony'],
  [/^Canon/i, 'Canon'],
  [/^FUJIFILM/i, 'FUJIFILM'],
  [/^LEICA/i, 'Leica'],
  [/^HASSELBLAD/i, 'Hasselblad'],
  [/^SIGMA/i, 'SIGMA'],
];

// Brand words that may open a Model string; keyed lower-case.
const BRANDS = new Map(
  ['Canon', 'Nikon', 'Sony', 'FUJIFILM', 'Panasonic', 'OLYMPUS', 'PENTAX', 'RICOH', 'Leica',
    'Hasselblad', 'SIGMA', 'Samsung', 'Kodak', 'DJI', 'Google', 'Xiaomi', 'HUAWEI', 'OPPO',
    'OnePlus', 'Minolta', 'CASIO', 'GoPro', 'Insta360'].map((b) => [b.toLowerCase(), b]),
);

export function cleanMake(make) {
  if (!make) return null;
  for (const [re, name] of MAKE_ALIASES) if (re.test(make)) return name;
  return make.replace(/[\s,]+(corporation|corp\.?|co\.?,?\s*ltd\.?|inc\.?|ltd\.?)$/i, '').trim() || null;
}

export function cameraName(make, model) {
  const mk = cleanMake(make);
  const mdl = model ? model.replace(/\s+/g, ' ').trim() : '';
  if (!mdl) return mk;
  if (!mk) return mdl;
  // Model strings often repeat the brand ("NIKON Z 6_2", "PENTAX K-1" from
  // RICOH IMAGING); keep a single, consistently cased brand word.
  const [head, ...rest] = mdl.split(' ');
  const lower = head.toLowerCase();
  if (lower === mk.split(' ')[0].toLowerCase()) return [mk, ...rest].join(' ');
  if (BRANDS.has(lower)) return [BRANDS.get(lower), ...rest].join(' ');
  return `${mk} ${mdl}`;
}

// Turns raw tags into the flat record the dashboard works with.
export function normalize(tags) {
  const g = (t) => tags[t];

  let fnumber = num(g(TAG.FNumber));
  if (!(fnumber > 0)) {
    const av = num(g(TAG.ApertureValue));
    fnumber = av != null ? Math.pow(2, av / 2) : null;
  }
  if (!(fnumber > 0.3 && fnumber < 256)) fnumber = null;

  let exposure = num(g(TAG.ExposureTime));
  if (!(exposure > 0)) {
    const tv = num(g(TAG.ShutterSpeedValue));
    exposure = tv != null ? Math.pow(2, -tv) : null;
  }
  if (!(exposure > 0 && exposure < 36000)) exposure = null;

  let iso = num(g(TAG.ISO));
  if (!(iso > 0) || iso === 65535) {
    const rei = num(g(TAG.RecommendedExposureIndex));
    if (rei > 0) iso = rei;
    else if (!(iso > 0)) iso = null;
  }

  let focal = num(g(TAG.FocalLength));
  if (!(focal > 0 && focal < 5000)) focal = null;
  let focal35 = num(g(TAG.FocalLengthIn35mmFilm));
  if (!(focal35 > 0 && focal35 < 10000)) focal35 = null;

  const date =
    parseExifDate(g(TAG.DateTimeOriginal)) ??
    parseExifDate(g(TAG.DateTimeDigitized)) ??
    parseExifDate(g(TAG.DateTime));

  const str = (t) => (typeof g(t) === 'string' ? g(t) : null);
  const make = str(TAG.Make);
  const model = str(TAG.Model);
  let lens = str(TAG.LensModel);
  if (lens && /^(-+|0|unknown|n\/a|none)$/i.test(lens)) lens = null;
  if (!lens) lens = formatLensSpec(g(TAG.LensSpecification));
  if (!lens) {
    const info = g(TAG.DNGLensInfo);
    lens = typeof info === 'string' ? info : formatLensSpec(info);
  }

  const program = num(g(TAG.ExposureProgram));
  const flash = num(g(TAG.Flash));
  const bias = num(g(TAG.ExposureBiasValue));

  return {
    camera: cameraName(make, model),
    lens: lens ? lens.replace(/\s+/g, ' ').trim() : null,
    focal,
    focal35,
    fnumber,
    exposure,
    iso: iso ? Math.round(iso) : null,
    date,
    program: program != null && program >= 0 && program <= 9 ? program : null,
    flash: flash == null ? null : (flash & 1) === 1,
    bias: bias != null && Math.abs(bias) < 20 ? bias : null,
  };
}

export async function readExif(blob) {
  const tags = await readRawTags(blob);
  return tags ? normalize(tags) : null;
}
