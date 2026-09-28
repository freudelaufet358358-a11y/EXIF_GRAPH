// Builds synthetic image containers with a known Exif payload, so the parser
// can be tested without shipping real photos.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };

export const ASCII = 2;
export const SHORT = 3;
export const LONG = 4;
export const RATIONAL = 5;
export const UNDEFINED = 7;
export const SRATIONAL = 10;

function encodeValue(type, value) {
  if (type === ASCII) return { count: Buffer.byteLength(value) + 1, bytes: Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]) };
  if (type === UNDEFINED) return { count: value.length, bytes: Buffer.from(value) };
  const list = type === RATIONAL || type === SRATIONAL ? (Array.isArray(value[0]) ? value : [value]) : [].concat(value);
  return { count: list.length, list };
}

// entries: [[tag, type, value], ...]; returns a Buffer holding a TIFF stream.
// Pass `exif` to add an Exif sub-IFD linked from IFD0.
export function buildTiff({ le = true, magic = 42, ifd0 = [], exif = null }) {
  const buf = Buffer.alloc(1 << 20);
  const w16 = (v, o) => (le ? buf.writeUInt16LE(v, o) : buf.writeUInt16BE(v, o));
  const w32 = (v, o) => (le ? buf.writeUInt32LE(v >>> 0, o) : buf.writeUInt32BE(v >>> 0, o));
  const wi32 = (v, o) => (le ? buf.writeInt32LE(v, o) : buf.writeInt32BE(v, o));
  buf.write(le ? 'II' : 'MM', 0, 'latin1');
  w16(magic, 2);
  w32(8, 4);

  const ifd0Entries = [...ifd0];
  if (exif) ifd0Entries.push([0x8769, LONG, 0]); // patched below
  ifd0Entries.sort((a, b) => a[0] - b[0]);
  const ifd0Size = 2 + ifd0Entries.length * 12 + 4;
  const exifEntries = exif ? [...exif].sort((a, b) => a[0] - b[0]) : [];
  const exifOff = 8 + ifd0Size;
  const exifSize = exif ? 2 + exifEntries.length * 12 + 4 : 0;
  let data = exifOff + exifSize;

  const writeIfd = (at, entries) => {
    w16(entries.length, at);
    entries.forEach(([tag, type, value], i) => {
      const e = at + 2 + i * 12;
      w16(tag, e);
      w16(type, e + 2);
      if (tag === 0x8769) {
        w32(1, e + 4);
        w32(exifOff, e + 8);
        return;
      }
      const enc = encodeValue(type, value);
      w32(enc.count, e + 4);
      const size = enc.count * TYPE_SIZE[type];
      const target = size <= 4 ? e + 8 : data;
      if (size > 4) {
        w32(data, e + 8);
        data += size + (size & 1);
      }
      if (enc.bytes) enc.bytes.copy(buf, target);
      else {
        enc.list.forEach((v, j) => {
          const p = target + j * TYPE_SIZE[type];
          if (type === SHORT) w16(v, p);
          else if (type === LONG) w32(v, p);
          else if (type === RATIONAL) {
            w32(v[0], p);
            w32(v[1], p + 4);
          } else if (type === SRATIONAL) {
            wi32(v[0], p);
            wi32(v[1], p + 4);
          }
        });
      }
    });
    w32(0, at + 2 + entries.length * 12);
  };
  writeIfd(8, ifd0Entries);
  if (exif) writeIfd(exifOff, exifEntries);
  return buf.subarray(0, data);
}

export const SAMPLE_IFD0 = [
  [0x010f, ASCII, 'NIKON CORPORATION'],
  [0x0110, ASCII, 'NIKON Z 6_2'],
  [0x0132, ASCII, '2024:05:02 10:00:00'],
];
export const SAMPLE_EXIF = [
  [0x829a, RATIONAL, [1, 250]],
  [0x829d, RATIONAL, [28, 10]],
  [0x8822, SHORT, 3],
  [0x8827, SHORT, 400],
  [0x9003, ASCII, '2024:05:01 14:23:45'],
  [0x9204, SRATIONAL, [-1, 3]],
  [0x9209, SHORT, 16],
  [0x920a, RATIONAL, [50, 1]],
  [0xa405, SHORT, 50],
  [0xa434, ASCII, 'NIKKOR Z 50mm f/1.8 S'],
];

export function sampleTiff(opts = {}) {
  return buildTiff({ ifd0: SAMPLE_IFD0, exif: SAMPLE_EXIF, ...opts });
}

function seg(marker, payload) {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(marker, 0);
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}

export function jpegWith(tiff, { xmpFirst = false } = {}) {
  const jfif = seg(0xffe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
  const xmp = seg(0xffe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1'));
  const exif = seg(0xffe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
  const parts = [Buffer.from([0xff, 0xd8]), jfif];
  if (xmpFirst) parts.push(xmp);
  parts.push(exif, seg(0xffdb, Buffer.alloc(65)), Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(32, 0x55), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function box(type, ...payload) {
  const body = Buffer.concat(payload);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(body.length + 8, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}

function fullBox(type, version, flags, ...payload) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...payload);
}

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v, 0);
  return b;
}

// HEIF with an Exif item stored in mdat (construction method 0) or idat (1).
export function heifWith(tiff, { ilocVersion = 1, useIdat = false, brand = 'heic', exifPrefix = true } = {}) {
  const payload = exifPrefix
    ? Buffer.concat([u32(6), Buffer.from('Exif\0\0', 'latin1'), tiff])
    : Buffer.concat([u32(0), tiff]);
  const ftyp = box('ftyp', Buffer.from(`${brand}\0\0\0\0mif1${brand}`, 'latin1'));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(12), Buffer.from('\0'));
  const infe = (id, type) => fullBox('infe', 2, 0, u16(id), u16(0), Buffer.from(type, 'latin1'), Buffer.from('\0'));
  const iinf = fullBox('iinf', 0, 0, u16(2), infe(1, 'hvc1'), infe(2, 'Exif'));
  const makeIloc = (exifOffset) => {
    const item = (id, method, off, len) => {
      const parts = [u16(id)];
      if (ilocVersion >= 1) parts.push(u16(method));
      parts.push(u16(0), u16(1), u32(off), u32(len));
      return Buffer.concat(parts);
    };
    return fullBox('iloc', ilocVersion, 0, Buffer.from([0x44, 0x00]), u16(2), item(1, 0, 0, 0), item(2, useIdat ? 1 : 0, exifOffset, payload.length));
  };
  if (useIdat) {
    const idat = box('idat', payload);
    const meta = fullBox('meta', 0, 0, hdlr, iinf, makeIloc(0), idat);
    return Buffer.concat([ftyp, meta, box('mdat', Buffer.alloc(16))]);
  }
  const metaLen = fullBox('meta', 0, 0, hdlr, iinf, makeIloc(0)).length;
  const exifOffset = ftyp.length + metaLen + 8 + 16;
  const meta = fullBox('meta', 0, 0, hdlr, iinf, makeIloc(exifOffset));
  return Buffer.concat([ftyp, meta, box('mdat', Buffer.alloc(16), payload)]);
}

export function cr3With(ifd0Tiff, exifTiff) {
  const uuid = Buffer.from('85c0b687820f11e08111f4ce462b6a48', 'hex');
  const ftyp = box('ftyp', Buffer.from('crx \0\0\0\x01crx isom', 'latin1'));
  const canon = box('uuid', uuid, box('CNCV', Buffer.from('CanonCR3_001/00.10.00/00.00.00')), box('CMT1', ifd0Tiff), box('CMT2', exifTiff));
  const moov = box('moov', box('uuid', Buffer.alloc(16, 1)), canon, box('mvhd', Buffer.alloc(100)));
  return Buffer.concat([ftyp, moov, box('mdat', Buffer.alloc(64))]);
}

export function pngWith(tiff) {
  const chunk = (type, data) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, u32(0)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('eXIf', tiff),
    chunk('IDAT', Buffer.alloc(20)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function webpWith(tiff) {
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'latin1');
    h.writeUInt32LE(data.length, 4);
    return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), chunk('VP8X', Buffer.alloc(10)), chunk('VP8 ', Buffer.alloc(21)), chunk('EXIF', tiff)]);
  const h = Buffer.alloc(8);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}

export function rafWith(jpeg) {
  const head = Buffer.alloc(100);
  head.write('FUJIFILMCCD-RAW 0201FF383501', 0, 'latin1');
  head.writeUInt32BE(100, 84);
  head.writeUInt32BE(jpeg.length, 88);
  return Buffer.concat([head, jpeg, Buffer.alloc(256)]);
}

// Panasonic RW2: TIFF magic 0x55, Make/Model in IFD0 and the full Exif only
// inside the embedded JPEG (tag 0x002E).
export function rw2With(jpeg) {
  return buildTiff({
    magic: 0x55,
    ifd0: [
      [0x002e, UNDEFINED, jpeg],
      [0x010f, ASCII, 'Panasonic'],
      [0x0110, ASCII, 'DC-S5M2'],
    ],
  });
}

export function blobOf(buf) {
  return new Blob([buf]);
}
