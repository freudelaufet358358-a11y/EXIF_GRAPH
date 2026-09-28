// Binning and aggregation for the dashboard. Pure functions, no DOM.

const DAY = 86400000;

export const PROGRAM_LABELS = {
  0: '未定義',
  1: 'マニュアル',
  2: 'プログラムAE',
  3: '絞り優先',
  4: 'シャッター優先',
  5: 'クリエイティブ',
  6: 'アクション',
  7: 'ポートレート',
  8: '風景',
  9: 'バルブ',
};

export const FOCAL_RANGES = [
  { max: 20, label: '〜20mm', name: '超広角' },
  { max: 30, label: '21–30mm', name: '広角' },
  { max: 42, label: '31–42mm', name: '準広角' },
  { max: 60, label: '43–60mm', name: '標準' },
  { max: 105, label: '61–105mm', name: '中望遠' },
  { max: 200, label: '106–200mm', name: '望遠' },
  { max: 400, label: '201–400mm', name: '超望遠' },
  { max: Infinity, label: '401mm〜', name: '超望遠' },
];

// Conventional shutter labels, keyed by thirds of a stop faster than 1s
// (n = 3 * log2(1 / t)).
const SHUTTER_THIRDS = {
  '-15': '30"', '-14': '25"', '-13': '20"', '-12': '15"', '-11': '13"', '-10': '10"',
  '-9': '8"', '-8': '6"', '-7': '5"', '-6': '4"', '-5': '3.2"', '-4': '2.5"',
  '-3': '2"', '-2': '1.6"', '-1': '1.3"', 0: '1"', 1: '0.8"', 2: '0.6"',
  3: '1/2', 4: '0.4"', 5: '0.3"', 6: '1/4', 7: '1/5', 8: '1/6', 9: '1/8',
  10: '1/10', 11: '1/13', 12: '1/15', 13: '1/20', 14: '1/25', 15: '1/30',
  16: '1/40', 17: '1/50', 18: '1/60', 19: '1/80', 20: '1/100', 21: '1/125',
  22: '1/160', 23: '1/200', 24: '1/250', 25: '1/320', 26: '1/400', 27: '1/500',
  28: '1/640', 29: '1/800', 30: '1/1000', 31: '1/1250', 32: '1/1600', 33: '1/2000',
  34: '1/2500', 35: '1/3200', 36: '1/4000', 37: '1/5000', 38: '1/6400', 39: '1/8000',
  40: '1/10000', 41: '1/12800', 42: '1/16000', 43: '1/20000', 44: '1/25600', 45: '1/32000',
};

// Nominal ISO values, keyed by thirds of a stop from ISO 100.
const ISO_THIRDS = {
  '-9': 12, '-8': 16, '-7': 20, '-6': 25, '-5': 32, '-4': 40, '-3': 50, '-2': 64, '-1': 80,
  0: 100, 1: 125, 2: 160, 3: 200, 4: 250, 5: 320, 6: 400, 7: 500, 8: 640, 9: 800,
  10: 1000, 11: 1250, 12: 1600, 13: 2000, 14: 2500, 15: 3200, 16: 4000, 17: 5000,
  18: 6400, 19: 8000, 20: 10000, 21: 12800, 22: 16000, 23: 20000, 24: 25600,
  25: 32000, 26: 40000, 27: 51200, 28: 64000, 29: 80000, 30: 102400, 31: 128000,
  32: 160000, 33: 204800, 34: 256000, 35: 320000, 36: 409600,
};

// Nominal full-stop apertures, keyed by n = 2 * log2(F).
const APERTURE_STOPS = {
  '-2': '0.5', '-1': '0.7', 0: '1', 1: '1.4', 2: '2', 3: '2.8', 4: '4', 5: '5.6',
  6: '8', 7: '11', 8: '16', 9: '22', 10: '32', 11: '45', 12: '64', 13: '90', 14: '128',
};

export const fmt = (n) => n.toLocaleString('ja-JP');

export function pct(count, total) {
  if (!total) return '0%';
  const p = (count / total) * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
}

export function trimNum(x, digits = 1) {
  const f = 10 ** digits;
  return String(Math.round(x * f) / f);
}

function shutterText(t) {
  return t >= 0.3 ? `${trimNum(t)}"` : `1/${Math.round(1 / t)}`;
}

export function formatShutter(t) {
  return t > 0 ? shutterText(t) : '';
}

export function formatAperture(f) {
  return f >= 10 ? `F${Math.round(f)}` : `F${trimNum(f)}`;
}

// ------------------------------------------------------------ scales
// A scale maps a raw value to a numeric bin key and back to a label.
// `fill` scales are stop-based, so gaps between used bins are kept (count 0)
// to keep the axis honest.

const pos = (v) => typeof v === 'number' && v > 0;

export function focalRangeIndex(v) {
  const r = Math.round(v);
  return FOCAL_RANGES.findIndex((x) => r <= x.max);
}

export function apertureStopIndex(f) {
  return Math.round(2 * Math.log2(f));
}

export const SCALES = {
  focal: {
    key: (v) => (pos(v) ? (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)) : null),
    label: (k) => `${trimNum(k)}mm`,
  },
  focalRange: {
    key: (v) => (pos(v) ? focalRangeIndex(v) : null),
    label: (k) => FOCAL_RANGES[k].label,
    sub: (k) => FOCAL_RANGES[k].name,
    fill: true,
  },
  aperture: {
    key: (f) => (pos(f) ? Math.round(f * 10) / 10 : null),
    label: (k) => formatAperture(k),
  },
  apertureStop: {
    key: (f) => (pos(f) ? apertureStopIndex(f) : null),
    label: (n) => `F${APERTURE_STOPS[n] ?? trimNum(Math.SQRT2 ** n)}`,
    fill: true,
  },
  shutterThird: {
    key: (t) => (pos(t) ? Math.round(3 * Math.log2(1 / t)) : null),
    label: (n) => SHUTTER_THIRDS[n] ?? shutterText(2 ** (-n / 3)),
    fill: true,
  },
  shutterStop: {
    key: (t) => (pos(t) ? Math.round(Math.log2(1 / t)) : null),
    label: (n) => SHUTTER_THIRDS[n * 3] ?? shutterText(2 ** -n),
    fill: true,
  },
  isoThird: {
    key: (v) => (pos(v) ? Math.round(3 * Math.log2(v / 100)) : null),
    label: (n) => String(ISO_THIRDS[n] ?? Math.round(100 * 2 ** (n / 3))),
    fill: true,
  },
  isoStop: {
    key: (v) => (pos(v) ? Math.round(Math.log2(v / 100)) : null),
    label: (n) => String(ISO_THIRDS[n * 3] ?? Math.round(100 * 2 ** n)),
    fill: true,
  },
};

// ------------------------------------------------------------ aggregation

// Counts records into a scale's bins. Items are sorted by key.
export function histogram(records, get, scale) {
  const counts = new Map();
  let missing = 0;
  for (const r of records) {
    let k = scale.key(get(r));
    if (k == null || !Number.isFinite(k)) {
      missing++;
      continue;
    }
    if (Object.is(k, -0)) k = 0;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let keys = [...counts.keys()].sort((a, b) => a - b);
  if (scale.fill && keys.length > 1) {
    const lo = keys[0];
    const hi = keys[keys.length - 1];
    keys = [];
    for (let k = lo; k <= hi; k++) keys.push(k);
  }
  const items = keys.map((k) => ({
    key: k,
    label: scale.label(k),
    sub: scale.sub ? scale.sub(k) : undefined,
    count: counts.get(k) || 0,
  }));
  return { items, missing, counted: records.length - missing };
}

// Ranked categories (camera, lens, ...). Folds the tail into "その他".
export function ranking(records, get, { top = 10, unknownLabel = '（情報なし）', labels } = {}) {
  const map = new Map();
  let unknown = 0;
  for (const r of records) {
    const v = get(r);
    if (v == null || v === '') {
      unknown++;
      continue;
    }
    map.set(v, (map.get(v) || 0) + 1);
  }
  const all = [...map.entries()]
    .map(([key, count]) => ({ key, label: labels ? labels[key] ?? String(key) : String(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  let items = all;
  if (all.length > top + 1) {
    const rest = all.slice(top);
    items = all.slice(0, top);
    items.push({
      key: null,
      label: `その他 ${rest.length}種`,
      count: rest.reduce((s, x) => s + x.count, 0),
      other: true,
    });
  }
  if (unknown) items.push({ key: null, label: unknownLabel, count: unknown, unknown: true });
  return { items, distinct: all.length, unknown, total: records.length };
}

// Photos over time with an automatic granularity (day / month / year).
export function timeline(records) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of records) {
    if (r.date == null) continue;
    if (r.date < lo) lo = r.date;
    if (r.date > hi) hi = r.date;
  }
  if (lo === Infinity) return { items: [], unit: null, missing: records.length };
  const spanDays = (hi - lo) / DAY;
  const unit = spanDays <= 62 ? 'day' : spanDays <= 365 * 6 ? 'month' : 'year';
  const keyOf = (ts) => {
    if (unit === 'day') return Math.floor(ts / DAY);
    const d = new Date(ts);
    return unit === 'month' ? d.getUTCFullYear() * 12 + d.getUTCMonth() : d.getUTCFullYear();
  };
  const labelOf = (k) => {
    if (unit === 'day') {
      const d = new Date(k * DAY);
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    }
    if (unit === 'month') return `${Math.floor(k / 12)}/${String((k % 12) + 1).padStart(2, '0')}`;
    return `${k}年`;
  };
  const titleOf = (k) => {
    if (unit === 'day') return formatDate(k * DAY);
    if (unit === 'month') return `${Math.floor(k / 12)}年${(k % 12) + 1}月`;
    return `${k}年`;
  };
  const counts = new Map();
  let missing = 0;
  for (const r of records) {
    if (r.date == null) {
      missing++;
      continue;
    }
    const k = keyOf(r.date);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const items = [];
  for (let k = keyOf(lo); k <= keyOf(hi); k++) {
    items.push({ key: k, label: labelOf(k), title: titleOf(k), count: counts.get(k) || 0 });
  }
  return { items, unit, missing };
}

export function hourOfDay(records) {
  const counts = new Array(24).fill(0);
  let missing = 0;
  for (const r of records) {
    if (r.date == null) {
      missing++;
      continue;
    }
    counts[new Date(r.date).getUTCHours()]++;
  }
  return {
    items: counts.map((count, hr) => ({ key: hr, label: `${hr}時`, title: `${hr}:00〜${hr}:59`, count })),
    missing,
  };
}

// Focal range (rows) x full-stop aperture (columns).
export function focalApertureMatrix(records, getFocal) {
  const cells = new Map();
  let lo = Infinity;
  let hi = -Infinity;
  let rlo = Infinity;
  let rhi = -Infinity;
  let counted = 0;
  for (const r of records) {
    const f = getFocal(r);
    if (!pos(f) || !pos(r.fnumber)) continue;
    const row = focalRangeIndex(f);
    const col = apertureStopIndex(r.fnumber);
    lo = Math.min(lo, col);
    hi = Math.max(hi, col);
    rlo = Math.min(rlo, row);
    rhi = Math.max(rhi, row);
    const k = `${row}:${col}`;
    cells.set(k, (cells.get(k) || 0) + 1);
    counted++;
  }
  if (!counted) return { rows: [], cols: [], cells, max: 0, counted };
  const cols = [];
  for (let c = lo; c <= hi; c++) cols.push({ key: c, label: SCALES.apertureStop.label(c) });
  const rows = [];
  for (let i = rlo; i <= rhi; i++) {
    rows.push({ key: i, label: FOCAL_RANGES[i].label, sub: FOCAL_RANGES[i].name });
  }
  return { rows, cols, cells, max: Math.max(...cells.values()), counted };
}

export function mode(items) {
  let best = null;
  for (const it of items) if (!best || it.count > best.count) best = it;
  return best && best.count > 0 ? best : null;
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Fills in 35mm-equivalent focal lengths for photos that lack the tag, using
// the crop factor seen on other photos from the same camera.
export function estimateFocal35(records) {
  const ratios = new Map();
  for (const r of records) {
    if (r.focal35Est) {
      r.focal35 = null;
      r.focal35Est = false;
    }
  }
  for (const r of records) {
    if (r.focal > 0 && r.focal35 > 0 && r.camera) {
      if (!ratios.has(r.camera)) ratios.set(r.camera, []);
      ratios.get(r.camera).push(r.focal35 / r.focal);
    }
  }
  const crop = new Map();
  for (const [cam, list] of ratios) crop.set(cam, median(list));
  let estimated = 0;
  for (const r of records) {
    if (r.focal35 == null && r.focal > 0 && crop.has(r.camera)) {
      r.focal35 = Math.round(r.focal * crop.get(r.camera));
      r.focal35Est = true;
      estimated++;
    }
  }
  return estimated;
}

export function formatDate(ts, withTime = false) {
  if (ts == null) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  const s = `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
  return withTime ? `${s} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` : s;
}

export function countDays(records) {
  const days = new Set();
  for (const r of records) if (r.date != null) days.add(Math.floor(r.date / DAY));
  return days.size;
}
