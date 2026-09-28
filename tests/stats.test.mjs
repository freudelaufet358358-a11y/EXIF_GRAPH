import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../site/js/stats.js';
import { demoRecords } from '../site/js/demo.js';

const label = (scale, v) => scale.label(scale.key(v));

test('shutter speeds snap to conventional third and full stops', () => {
  const t = S.SCALES.shutterThird;
  assert.equal(label(t, 1 / 250), '1/250');
  assert.equal(label(t, 1 / 121), '1/125');
  assert.equal(label(t, 1 / 100), '1/100');
  assert.equal(label(t, 1 / 60), '1/60');
  assert.equal(label(t, 1 / 8000), '1/8000');
  assert.equal(label(t, 1), '1"');
  assert.equal(label(t, 30), '30"');
  assert.equal(label(t, 0.5), '1/2');
  const f = S.SCALES.shutterStop;
  assert.equal(label(f, 1 / 100), '1/125');
  assert.equal(label(f, 1 / 60), '1/60');
  assert.equal(label(f, 1 / 16000), '1/16000');
  assert.equal(label(f, 2), '2"');
});

test('ISO and aperture bins', () => {
  assert.equal(label(S.SCALES.isoThird, 100), '100');
  assert.equal(label(S.SCALES.isoThird, 1250), '1250');
  assert.equal(label(S.SCALES.isoThird, 1100), '1000');
  assert.equal(label(S.SCALES.isoThird, 32), '32');
  assert.equal(label(S.SCALES.isoStop, 1250), '1600');
  assert.equal(label(S.SCALES.isoStop, 64), '50');
  assert.equal(label(S.SCALES.aperture, 1.78), 'F1.8');
  assert.equal(label(S.SCALES.aperture, 2), 'F2');
  assert.equal(label(S.SCALES.aperture, 11), 'F11');
  assert.equal(label(S.SCALES.apertureStop, 1.8), 'F2');
  assert.equal(label(S.SCALES.apertureStop, 5.6), 'F5.6');
  assert.equal(label(S.SCALES.apertureStop, 6.3), 'F5.6');
  assert.equal(label(S.SCALES.apertureStop, 7.1), 'F8');
});

test('focal bins and ranges', () => {
  assert.equal(label(S.SCALES.focal, 6.765), '6.8mm');
  assert.equal(label(S.SCALES.focal, 50), '50mm');
  assert.equal(label(S.SCALES.focal, 23.5), '24mm');
  assert.equal(label(S.SCALES.focalRange, 24), '21–30mm');
  assert.equal(label(S.SCALES.focalRange, 50), '43–60mm');
  assert.equal(label(S.SCALES.focalRange, 600), '401mm〜');
  assert.equal(S.SCALES.focal.key(null), null);
  assert.equal(S.SCALES.focal.key(0), null);
});

test('histogram fills gaps only on stop scales and counts missing values', () => {
  const recs = [{ v: 1 / 250 }, { v: 1 / 250 }, { v: 1 / 30 }, { v: null }];
  const h = S.histogram(recs, (r) => r.v, S.SCALES.shutterStop);
  assert.equal(h.missing, 1);
  assert.equal(h.counted, 3);
  assert.deepEqual(h.items.map((i) => i.label), ['1/30', '1/60', '1/125', '1/250']);
  assert.deepEqual(h.items.map((i) => i.count), [1, 0, 0, 2]);

  const f = S.histogram([{ v: 24 }, { v: 70 }, { v: 24 }], (r) => r.v, S.SCALES.focal);
  assert.deepEqual(f.items.map((i) => [i.label, i.count]), [['24mm', 2], ['70mm', 1]]);
});

test('ranking folds the tail and reports unknowns last', () => {
  const recs = [];
  for (let i = 0; i < 15; i++) for (let j = 0; j <= i; j++) recs.push({ c: `cam${i}` });
  recs.push({ c: null }, { c: null });
  const r = S.ranking(recs, (x) => x.c, { top: 5 });
  assert.equal(r.items.length, 7);
  assert.equal(r.items[0].label, 'cam14');
  assert.equal(r.items[5].other, true);
  assert.equal(r.items[5].label, 'その他 10種');
  assert.equal(r.items[6].unknown, true);
  assert.equal(r.items[6].count, 2);
  assert.equal(r.distinct, 15);
  assert.equal(r.items.reduce((a, b) => a + b.count, 0), recs.length);
});

test('timeline picks a granularity and keeps empty periods', () => {
  const d = (y, m, day) => ({ date: Date.UTC(y, m - 1, day, 12) });
  const days = S.timeline([d(2024, 5, 1), d(2024, 5, 3), d(2024, 5, 3)]);
  assert.equal(days.unit, 'day');
  assert.deepEqual(days.items.map((i) => i.count), [1, 0, 2]);
  const months = S.timeline([d(2023, 11, 1), d(2024, 2, 1), { date: null }]);
  assert.equal(months.unit, 'month');
  assert.deepEqual(months.items.map((i) => i.label), ['2023/11', '2023/12', '2024/01', '2024/02']);
  assert.equal(months.missing, 1);
  const years = S.timeline([d(2010, 1, 1), d(2024, 1, 1)]);
  assert.equal(years.unit, 'year');
  assert.equal(years.items.length, 15);
});

test('35mm equivalents are estimated per camera', () => {
  const recs = [
    { camera: 'A', focal: 23, focal35: 35 },
    { camera: 'A', focal: 16, focal35: 24 },
    { camera: 'A', focal: 56, focal35: null },
    { camera: 'B', focal: 50, focal35: null },
  ];
  assert.equal(S.estimateFocal35(recs), 1);
  assert.equal(recs[2].focal35, 85);
  assert.equal(recs[2].focal35Est, true);
  assert.equal(recs[3].focal35, null);
  // Re-running starts from scratch rather than compounding estimates.
  assert.equal(S.estimateFocal35(recs), 1);
});

test('focal x aperture matrix', () => {
  const m = S.focalApertureMatrix(
    [{ f: 24, fnumber: 2.8 }, { f: 24, fnumber: 2.8 }, { f: 85, fnumber: 1.4 }, { f: null, fnumber: 2 }],
    (r) => r.f,
  );
  assert.equal(m.counted, 3);
  assert.deepEqual(m.cols.map((c) => c.label), ['F1.4', 'F2', 'F2.8']);
  assert.deepEqual(m.rows.map((r) => r.label), ['21–30mm', '31–42mm', '43–60mm', '61–105mm']);
  assert.equal(m.max, 2);
});

test('demo data is deterministic and well-formed', () => {
  const a = demoRecords(300);
  const b = demoRecords(300);
  assert.equal(a.length, 300);
  assert.deepEqual(a, b);
  for (const r of a) {
    assert.ok(r.camera && r.lens && r.focal > 0 && r.focal35 > 0 && r.fnumber > 0);
    assert.ok(r.exposure > 0 && r.iso > 0 && Number.isFinite(r.date));
  }
});

test('percent formatting', () => {
  assert.equal(S.pct(1, 3), '33%');
  assert.equal(S.pct(1, 30), '3.3%');
  assert.equal(S.pct(1, 5000), '<0.1%');
  assert.equal(S.pct(0, 0), '0%');
});
