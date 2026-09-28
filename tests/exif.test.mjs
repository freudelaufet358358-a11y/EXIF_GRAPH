import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExif, cameraName, formatLensSpec, parseExifDate } from '../site/js/exif.js';
import {
  ASCII, RATIONAL, SHORT, SAMPLE_EXIF,
  blobOf, buildTiff, cr3With, heifWith, jpegWith, pngWith, rafWith, rw2With, sampleTiff, webpWith,
} from './builders.mjs';

function assertSample(rec, camera = 'Nikon Z 6_2') {
  assert.ok(rec, 'record parsed');
  assert.equal(rec.camera, camera);
  assert.equal(rec.lens, 'NIKKOR Z 50mm f/1.8 S');
  assert.equal(rec.focal, 50);
  assert.equal(rec.focal35, 50);
  assert.equal(rec.fnumber, 2.8);
  assert.equal(rec.exposure, 1 / 250);
  assert.equal(rec.iso, 400);
  assert.equal(rec.program, 3);
  assert.equal(rec.flash, false);
  assert.ok(Math.abs(rec.bias + 1 / 3) < 1e-9);
  // DateTimeOriginal wins over IFD0 DateTime.
  assert.equal(rec.date, Date.UTC(2024, 4, 1, 14, 23, 45));
}

test('JPEG, little-endian TIFF', async () => {
  assertSample(await readExif(blobOf(jpegWith(sampleTiff()))));
});

test('JPEG, big-endian TIFF, XMP segment before Exif', async () => {
  assertSample(await readExif(blobOf(jpegWith(sampleTiff({ le: false }), { xmpFirst: true }))));
});

test('JPEG whose Exif lies beyond the initial read window', async () => {
  const tiff = sampleTiff();
  // Two 50 KB APP2 segments push the Exif block past the 64 KB head.
  const big = [];
  for (let i = 0; i < 2; i++) {
    const seg = Buffer.alloc(4 + 50000);
    seg.writeUInt16BE(0xffe2, 0);
    seg.writeUInt16BE(50002, 2);
    big.push(seg);
  }
  const jpeg = jpegWith(tiff);
  const out = Buffer.concat([jpeg.subarray(0, 2), ...big, jpeg.subarray(2)]);
  assertSample(await readExif(blobOf(out)));
});

test('TIFF-based RAW (DNG/NEF/ARW style), both byte orders', async () => {
  assertSample(await readExif(blobOf(sampleTiff())));
  assertSample(await readExif(blobOf(sampleTiff({ le: false }))));
});

test('Olympus ORF magic', async () => {
  assertSample(await readExif(blobOf(sampleTiff({ magic: 0x4f52 }))));
});

test('Panasonic RW2 with Exif inside the embedded JPEG', async () => {
  const rec = await readExif(blobOf(rw2With(jpegWith(sampleTiff()))));
  // Make/Model from the RW2 IFD0 take precedence over the embedded JPEG.
  assert.equal(rec.camera, 'Panasonic DC-S5M2');
  assert.equal(rec.fnumber, 2.8);
  assert.equal(rec.focal, 50);
  assert.equal(rec.iso, 400);
});

test('HEIC with Exif item in mdat (iloc v0 and v1)', async () => {
  assertSample(await readExif(blobOf(heifWith(sampleTiff(), { ilocVersion: 0 }))));
  assertSample(await readExif(blobOf(heifWith(sampleTiff({ le: false }), { ilocVersion: 1 }))));
});

test('HEIF with Exif item in idat and no "Exif" prefix', async () => {
  assertSample(await readExif(blobOf(heifWith(sampleTiff(), { useIdat: true, exifPrefix: false }))));
});

test('AVIF', async () => {
  assertSample(await readExif(blobOf(heifWith(sampleTiff(), { brand: 'avif' }))));
});

test('Canon CR3 (CMT1 + CMT2)', async () => {
  const ifd0 = buildTiff({ ifd0: [[0x010f, ASCII, 'Canon'], [0x0110, ASCII, 'Canon EOS R5']] });
  const exif = buildTiff({ ifd0: SAMPLE_EXIF });
  assertSample(await readExif(blobOf(cr3With(ifd0, exif))), 'Canon EOS R5');
});

test('Fujifilm RAF via embedded JPEG', async () => {
  assertSample(await readExif(blobOf(rafWith(jpegWith(sampleTiff())))));
});

test('PNG eXIf and WebP EXIF chunks', async () => {
  assertSample(await readExif(blobOf(pngWith(sampleTiff()))));
  assertSample(await readExif(blobOf(webpWith(sampleTiff({ le: false })))));
});

test('files without Exif return null', async () => {
  assert.equal(await readExif(blobOf(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0xff, 0xd9]))), null);
  assert.equal(await readExif(blobOf(Buffer.alloc(4096))), null);
  assert.equal(await readExif(blobOf(Buffer.from('hello'))), null);
});

test('corrupt offsets do not throw', async () => {
  const tiff = sampleTiff();
  const bad = Buffer.from(tiff);
  bad.writeUInt32LE(0x7fffffff, 4); // IFD0 offset far past the end
  assert.equal(await readExif(blobOf(jpegWith(bad))), null);
});

test('APEX fallbacks and ISO overflow', async () => {
  const tiff = buildTiff({
    ifd0: [[0x010f, ASCII, 'SONY'], [0x0110, ASCII, 'ILCE-7M4']],
    exif: [
      [0x9201, 10, [8, 1]], // ShutterSpeedValue: 2^-8 = 1/256
      [0x9202, RATIONAL, [4, 1]], // ApertureValue: 2^(4/2) = F4
      [0x8827, SHORT, 65535],
      [0x8832, 4, 102400],
      [0xa432, RATIONAL, [[24, 1], [70, 1], [28, 10], [28, 10]]],
    ],
  });
  const rec = await readExif(blobOf(jpegWith(tiff)));
  assert.equal(rec.camera, 'Sony ILCE-7M4');
  assert.equal(rec.exposure, 1 / 256);
  assert.equal(rec.fnumber, 4);
  assert.equal(rec.iso, 102400);
  assert.equal(rec.lens, '24-70mm F2.8');
  assert.equal(rec.date, null);
});

test('camera names are tidied', () => {
  assert.equal(cameraName('Canon', 'Canon EOS R5'), 'Canon EOS R5');
  assert.equal(cameraName('NIKON CORPORATION', 'NIKON D850'), 'Nikon D850');
  assert.equal(cameraName('SONY', 'ILCE-7M3'), 'Sony ILCE-7M3');
  assert.equal(cameraName('Apple', 'iPhone 15 Pro'), 'Apple iPhone 15 Pro');
  assert.equal(cameraName('OM Digital Solutions', 'OM-1'), 'OM SYSTEM OM-1');
  assert.equal(cameraName('RICOH IMAGING COMPANY, LTD.', 'PENTAX K-1'), 'PENTAX K-1');
  assert.equal(cameraName('RICOH IMAGING COMPANY, LTD.', 'RICOH GR III'), 'RICOH GR III');
  assert.equal(cameraName('LEICA CAMERA AG', 'LEICA Q2'), 'Leica Q2');
  assert.equal(cameraName('FUJIFILM', 'X-T5'), 'FUJIFILM X-T5');
  assert.equal(cameraName('Xiaomi', null), 'Xiaomi');
  assert.equal(cameraName(null, 'X100V'), 'X100V');
});

test('lens spec and date helpers', () => {
  assert.equal(formatLensSpec([50, 50, 1.8, 1.8]), '50mm F1.8');
  assert.equal(formatLensSpec([18, 55, 3.5, 5.6]), '18-55mm F3.5-5.6');
  assert.equal(formatLensSpec([0, 0, 0, 0]), null);
  assert.equal(parseExifDate('2023:12:31 23:59:58'), Date.UTC(2023, 11, 31, 23, 59, 58));
  assert.equal(parseExifDate('0000:00:00 00:00:00'), null);
  assert.equal(parseExifDate('    :  :     :  :  '), null);
});
