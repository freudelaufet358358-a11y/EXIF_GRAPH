// Deterministic synthetic library so the dashboard can be tried without photos.

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, weighted) {
  const total = weighted.reduce((a, [, w]) => a + w, 0);
  let x = rand() * total;
  for (const [v, w] of weighted) {
    x -= w;
    if (x <= 0) return v;
  }
  return weighted[weighted.length - 1][0];
}

function gauss(rand) {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}

const KIT = [
  {
    camera: 'Sony ILCE-7M4',
    crop: 1,
    weight: 55,
    lenses: [
      { name: 'FE 24-70mm F2.8 GM II', w: 45, focal: [[24, 30], [28, 8], [35, 14], [40, 6], [50, 12], [60, 5], [70, 25]], f: [[2.8, 55], [4, 20], [5.6, 12], [8, 13]] },
      { name: 'FE 50mm F1.2 GM', w: 25, focal: [[50, 1]], f: [[1.2, 45], [1.4, 12], [2, 18], [2.8, 12], [4, 8], [5.6, 5]] },
      { name: 'FE 70-200mm F2.8 GM OSS II', w: 18, focal: [[70, 14], [85, 6], [100, 7], [135, 12], [150, 5], [200, 40]], f: [[2.8, 70], [4, 20], [5.6, 10]] },
      { name: 'FE 16-35mm F4 G PZ', w: 12, focal: [[16, 45], [20, 20], [24, 18], [35, 17]], f: [[4, 20], [5.6, 20], [8, 40], [11, 20]] },
    ],
    program: [[3, 70], [1, 22], [2, 8]],
  },
  {
    camera: 'FUJIFILM X-T5',
    crop: 1.5,
    weight: 28,
    lenses: [
      { name: 'XF23mmF1.4 R LM WR', w: 55, focal: [[23, 1]], f: [[1.4, 40], [2, 25], [2.8, 15], [4, 10], [5.6, 10]] },
      { name: 'XF16-55mmF2.8 R LM WR', w: 30, focal: [[16, 25], [23, 20], [35, 25], [55, 30]], f: [[2.8, 60], [4, 25], [8, 15]] },
      { name: 'XF56mmF1.2 R WR', w: 15, focal: [[56, 1]], f: [[1.2, 60], [1.4, 15], [2, 15], [2.8, 10]] },
    ],
    program: [[3, 55], [1, 35], [2, 10]],
  },
  {
    camera: 'Apple iPhone 15 Pro',
    crop: null,
    weight: 17,
    lenses: [
      { name: 'iPhone 15 Pro back triple camera 6.765mm f/1.78', w: 70, focal: [[6.765, 1]], f: [[1.78, 1]], eq: 24 },
      { name: 'iPhone 15 Pro back triple camera 2.22mm f/2.2', w: 15, focal: [[2.22, 1]], f: [[2.2, 1]], eq: 13 },
      { name: 'iPhone 15 Pro back triple camera 9mm f/2.8', w: 15, focal: [[9, 1]], f: [[2.8, 1]], eq: 77 },
    ],
    program: [[2, 1]],
  },
];

export function demoRecords(count = 1200, seed = 20240501) {
  const rand = rng(seed);
  const start = Date.UTC(2024, 0, 1);
  const end = Date.UTC(2025, 11, 31);
  const out = [];
  let i = 0;
  while (out.length < count) {
    // Shoot in "sessions": a day with a burst of photos.
    const day = start + Math.floor(rand() * ((end - start) / 86400000)) * 86400000;
    const kit = pick(rand, KIT.map((k) => [k, k.weight]));
    const burst = 3 + Math.floor(rand() * 40);
    const baseHour = pick(rand, [[7, 2], [9, 4], [11, 5], [13, 6], [15, 6], [16, 7], [17, 5], [19, 3], [21, 1]]);
    const bright = rand();
    for (let b = 0; b < burst && out.length < count; b++, i++) {
      const lens = pick(rand, kit.lenses.map((l) => [l, l.w]));
      const focal = pick(rand, lens.focal);
      const fnumber = pick(rand, lens.f);
      const minutes = baseHour * 60 + b * (2 + Math.floor(rand() * 6));
      const date = day + Math.min(minutes, 23 * 60 + 59) * 60000 + Math.floor(rand() * 60) * 1000;
      // Exposure: brighter scenes -> faster shutter, lower ISO.
      const ev = 9 + bright * 6 + gauss(rand) * 1.2;
      let iso = kit.crop == null ? 50 * 2 ** Math.max(0, (12 - ev) / 1.3) : 100 * 2 ** Math.max(0, (11.5 - ev) / 1.2);
      iso = Math.round(Math.min(12800, iso));
      const exposure = Math.min(1, (fnumber * fnumber) / 2 ** ev / (iso / 100));
      const eq = lens.eq ?? Math.round(focal * kit.crop);
      out.push({
        path: `demo/${kit.camera.replace(/\s+/g, '_')}/DSC${String(10000 + i).slice(1)}.jpg`,
        camera: kit.camera,
        lens: lens.name,
        focal,
        focal35: eq,
        fnumber,
        exposure,
        iso,
        date,
        program: pick(rand, kit.program),
        flash: rand() < 0.03,
        bias: Math.round(gauss(rand) * 1.5) / 3,
      });
    }
  }
  return out;
}
