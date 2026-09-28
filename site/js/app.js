import { readExif } from './exif.js';
import * as S from './stats.js';
import { columnChart, barList, heatmap, dataTable, h } from './charts.js';
import { demoRecords } from './demo.js';

const SUPPORTED = /\.(jpe?g|jpe|jfif|heic|heif|hif|avif|tiff?|dng|cr2|cr3|nef|nrw|arw|srf|sr2|orf|rw2|raf|pef|srw|3fr|erf|iiq|mef|mos|kdc|dcr|png|webp)$/i;
const CONCURRENCY = 8;
const NONE = '\u0000none';
const THEME_KEY = 'exif-graph-theme';
const { fmt, pct } = S;

const state = {
  records: [],
  seen: new Set(),
  counts: { noExif: 0, failed: 0, unsupported: 0 },
  estimated: 0,
  demo: false,
  filters: { camera: '', lens: '', from: '', to: '' },
  basis: 'eq',
  modes: {},
  views: {},
  scan: null,
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ filters

const focalOf = (r) => (state.basis === 'eq' ? r.focal35 : r.focal);
const basisLabel = () => (state.basis === 'eq' ? '35mm換算' : '実焦点距離');

function matches(value, filter) {
  if (!filter) return true;
  return filter === NONE ? value == null : value === filter;
}

function filtered(except) {
  const f = state.filters;
  const from = f.from ? Date.parse(`${f.from}T00:00:00Z`) : null;
  const to = f.to ? Date.parse(`${f.to}T23:59:59Z`) : null;
  return state.records.filter(
    (r) =>
      (except === 'camera' || matches(r.camera, f.camera)) &&
      (except === 'lens' || matches(r.lens, f.lens)) &&
      (from == null || (r.date != null && r.date >= from)) &&
      (to == null || (r.date != null && r.date <= to)),
  );
}

function filtersActive() {
  const f = state.filters;
  return Boolean(f.camera || f.lens || f.from || f.to);
}

function withNoneKey(items) {
  return items.map((i) => (i.unknown ? { ...i, key: NONE } : i));
}

// ------------------------------------------------------------------ cards

function missingNote(missing, what) {
  return missing ? `${what}の記録がない ${fmt(missing)}枚は除いています。` : '';
}

function columnTable(items, total, head) {
  return {
    columns: [{ label: head }, { label: '枚数', num: true }, { label: '割合', num: true }],
    rows: items.map((i) => [i.sub ? `${i.label}（${i.sub}）` : i.title || i.label, fmt(i.count), pct(i.count, total)]),
  };
}

function histogramSpec(recs, get, scale, what, desc) {
  const hist = S.histogram(recs, get, scale);
  return {
    kind: 'columns',
    items: hist.items,
    total: hist.counted,
    desc: desc(hist),
    note: missingNote(hist.missing, what),
    table: columnTable(hist.items, hist.counted, what),
    aria: `${what}の分布`,
  };
}

const CARDS = [
  {
    id: 'focal',
    title: '焦点距離',
    wide: true,
    modes: [['value', '値ごと'], ['range', 'レンジ別']],
    build(recs, mode) {
      const scale = mode === 'range' ? S.SCALES.focalRange : S.SCALES.focal;
      const spec = histogramSpec(recs, focalOf, scale, '焦点距離', (hh) => `${basisLabel()}・${fmt(hh.counted)}枚`);
      if (state.basis === 'eq') {
        const est = recs.filter((r) => r.focal35Est).length;
        if (est) spec.note += ` ${fmt(est)}枚は換算値が記録されていないため、同じカメラの他の写真から推定しています。`;
      }
      return spec;
    },
  },
  {
    id: 'aperture',
    title: '絞り（F値）',
    modes: [['value', '値ごと'], ['stop', '1段ごと']],
    build(recs, mode) {
      const scale = mode === 'stop' ? S.SCALES.apertureStop : S.SCALES.aperture;
      return histogramSpec(recs, (r) => r.fnumber, scale, '絞り', (hh) => `${fmt(hh.counted)}枚`);
    },
  },
  {
    id: 'shutter',
    title: 'シャッター速度',
    modes: [['third', '1/3段'], ['stop', '1段']],
    build(recs, mode) {
      const scale = mode === 'stop' ? S.SCALES.shutterStop : S.SCALES.shutterThird;
      return histogramSpec(recs, (r) => r.exposure, scale, 'シャッター速度', (hh) => `${fmt(hh.counted)}枚・左ほど低速`);
    },
  },
  {
    id: 'iso',
    title: 'ISO感度',
    modes: [['third', '1/3段'], ['stop', '1段']],
    build(recs, mode) {
      const scale = mode === 'stop' ? S.SCALES.isoStop : S.SCALES.isoThird;
      return histogramSpec(recs, (r) => r.iso, scale, 'ISO感度', (hh) => `${fmt(hh.counted)}枚`);
    },
  },
  {
    id: 'combo',
    title: '焦点距離 × 絞り',
    wide: true,
    build(recs) {
      const m = S.focalApertureMatrix(recs, focalOf);
      const rows = m.rows.map((r) => [
        `${r.label}（${r.sub}）`,
        ...m.cols.map((c) => fmt(m.cells.get(`${r.key}:${c.key}`) || 0)),
      ]);
      return {
        kind: 'heat',
        matrix: m,
        desc: `${basisLabel()}のレンジ × 1段ごとの絞り・${fmt(m.counted)}枚`,
        note: 'どの画角でどこまで絞っているか（開けているか）の組み合わせです。',
        table: {
          columns: [{ label: '焦点距離' }, ...m.cols.map((c) => ({ label: c.label, num: true }))],
          rows,
        },
        aria: '焦点距離と絞りの組み合わせのヒートマップ',
      };
    },
  },
  {
    id: 'camera',
    title: 'カメラ',
    build(recs) {
      const rank = S.ranking(recs, (r) => r.camera, { top: 12 });
      return rankSpec(rank, 'camera', 'カメラ', `${fmt(rank.distinct)}台`);
    },
  },
  {
    id: 'lens',
    title: 'レンズ',
    build(recs) {
      const rank = S.ranking(recs, (r) => r.lens, { top: 12 });
      return rankSpec(rank, 'lens', 'レンズ', `${fmt(rank.distinct)}本`);
    },
  },
  {
    id: 'timeline',
    title: '撮影時期',
    wide: true,
    build(recs) {
      const t = S.timeline(recs);
      const unitLabel = { day: '日別', month: '月別', year: '年別' }[t.unit] || '';
      const total = recs.length - t.missing;
      return {
        kind: 'columns',
        items: t.items,
        total,
        desc: `${unitLabel}の撮影枚数`,
        note: missingNote(t.missing, '撮影日時'),
        table: columnTable(t.items, total, '期間'),
        aria: '撮影時期ごとの枚数',
      };
    },
  },
  {
    id: 'hour',
    title: '撮影時間帯',
    build(recs) {
      const t = S.hourOfDay(recs);
      const total = recs.length - t.missing;
      return {
        kind: 'columns',
        items: t.items,
        total,
        desc: 'カメラの時計での時刻',
        note: missingNote(t.missing, '撮影日時'),
        table: columnTable(t.items, total, '時間帯'),
        aria: '時間帯ごとの撮影枚数',
      };
    },
  },
  {
    id: 'program',
    title: '撮影モード',
    build(recs) {
      const rank = S.ranking(recs, (r) => r.program, { labels: S.PROGRAM_LABELS, top: 9 });
      return {
        kind: 'bars',
        items: rank.items,
        total: rank.total,
        desc: '露出プログラム',
        note: '',
        table: rankTable(rank),
        aria: '撮影モードの内訳',
      };
    },
  },
];

function rankTable(rank) {
  return {
    columns: [{ label: '名前' }, { label: '枚数', num: true }, { label: '割合', num: true }],
    rows: rank.items.map((i) => [i.label, fmt(i.count), pct(i.count, rank.total)]),
  };
}

function rankSpec(rank, field, what, desc) {
  return {
    kind: 'bars',
    items: withNoneKey(rank.items),
    total: rank.total,
    desc,
    note: `行を選ぶと、その${what}だけに絞り込みます。`,
    table: rankTable(rank),
    aria: `${what}ごとの枚数`,
    selectedKey: state.filters[field] || null,
    onSelect: (it) => {
      state.filters[field] = state.filters[field] === it.key ? '' : it.key;
      if (field === 'camera') keepLensValid();
      render();
    },
  };
}

function keepLensValid() {
  if (!state.filters.lens) return;
  const ok = filtered('lens').some((r) => matches(r.lens, state.filters.lens));
  if (!ok) state.filters.lens = '';
}

function buildCard(card) {
  const el = h('article', `card${card.wide ? ' wide' : ''}`);
  el.id = `card-${card.id}`;
  const head = h('div', 'card-head');
  const title = h('div', 'card-title');
  title.appendChild(h('h2', null, card.title));
  const desc = h('p');
  title.appendChild(desc);
  head.appendChild(title);
  const tools = h('div', 'card-tools');

  const segment = (label, options, get, set) => {
    const seg = h('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', label);
    const buttons = options.map(([value, text]) => {
      const b = h('button', null, text);
      b.type = 'button';
      b.addEventListener('click', () => {
        set(value);
        sync();
        renderCard(card, currentRecords(card));
      });
      seg.appendChild(b);
      return [value, b];
    });
    const sync = () => buttons.forEach(([v, b]) => b.setAttribute('aria-pressed', String(v === get())));
    sync();
    tools.appendChild(seg);
  };

  if (card.modes) {
    segment(
      '集計単位',
      card.modes,
      () => state.modes[card.id] ?? card.modes[0][0],
      (v) => (state.modes[card.id] = v),
    );
  }
  segment(
    '表示形式',
    [['chart', 'グラフ'], ['table', '表']],
    () => state.views[card.id] ?? 'chart',
    (v) => (state.views[card.id] = v),
  );
  head.appendChild(tools);
  const body = h('div', 'card-body');
  const foot = h('p', 'card-foot');
  el.append(head, body, foot);
  card.el = { root: el, desc, body, foot };
  return el;
}

function currentRecords(card) {
  if (card.id === 'camera') return filtered('camera');
  if (card.id === 'lens') return filtered('lens');
  return filtered();
}

function renderCard(card, recs) {
  const mode = state.modes[card.id] ?? card.modes?.[0][0];
  const spec = card.build(recs, mode);
  const { desc, body, foot } = card.el;
  desc.textContent = spec.desc;
  foot.textContent = spec.note.trim();
  foot.hidden = !spec.note;

  const host = h('div');
  body.replaceChildren(host);
  const hasData = spec.kind === 'heat' ? spec.matrix.counted > 0 : spec.items.some((i) => i.count);
  if (!hasData) {
    host.appendChild(h('p', 'empty', '表示できるデータがありません'));
    return;
  }
  if ((state.views[card.id] ?? 'chart') === 'table') {
    dataTable(host, spec.table.columns, spec.table.rows, spec.aria);
    return;
  }
  if (spec.kind === 'columns') {
    columnChart(host, spec.items, { total: spec.total, ariaLabel: spec.aria });
  } else if (spec.kind === 'bars') {
    barList(host, spec.items, { total: spec.total, onSelect: spec.onSelect, selectedKey: spec.selectedKey });
  } else {
    heatmap(host, spec.matrix, { ariaLabel: spec.aria, corner: '焦点距離＼絞り' });
  }
}

// ------------------------------------------------------------------ KPIs

function renderKpis(recs) {
  const tiles = [];
  const all = state.records.length;
  const cams = new Set(recs.map((r) => r.camera).filter(Boolean)).size;
  const lenses = new Set(recs.map((r) => r.lens).filter(Boolean)).size;
  tiles.push({
    label: '写真',
    value: `${fmt(recs.length)}枚`,
    sub: filtersActive() ? `全${fmt(all)}枚のうち（絞り込み中）` : `カメラ ${cams}台・レンズ ${lenses}本`,
  });

  let lo = Infinity;
  let hi = -Infinity;
  for (const r of recs) {
    if (r.date == null) continue;
    lo = Math.min(lo, r.date);
    hi = Math.max(hi, r.date);
  }
  tiles.push(
    lo === Infinity
      ? { label: '撮影期間', value: '—', sub: '撮影日時の記録なし' }
      : {
          label: '撮影期間',
          value: lo === hi || S.formatDate(lo) === S.formatDate(hi) ? S.formatDate(lo) : `${S.formatDate(lo)} – ${S.formatDate(hi)}`,
          long: true,
          sub: `${fmt(S.countDays(recs))}日間に撮影`,
        },
  );

  const top = (get, scale, label, suffix = '') => {
    const hist = S.histogram(recs, get, scale);
    const m = S.mode(hist.items);
    return m
      ? { label, value: m.label, sub: `${pct(m.count, hist.counted)}（${fmt(m.count)}枚）${suffix}` }
      : { label, value: '—', sub: '記録なし' };
  };
  tiles.push(top(focalOf, S.SCALES.focal, 'いちばん多い焦点距離', `・${basisLabel()}`));
  tiles.push(top((r) => r.fnumber, S.SCALES.aperture, 'いちばん多い絞り'));
  tiles.push(top((r) => r.exposure, S.SCALES.shutterThird, 'いちばん多いシャッター速度'));
  const isoMed = S.median(recs.map((r) => r.iso));
  tiles.push({
    label: 'ISO感度（中央値）',
    value: isoMed == null ? '—' : fmt(Math.round(isoMed)),
    sub: isoMed == null ? '記録なし' : `半数の写真はISO ${fmt(Math.round(isoMed))}以下`,
  });

  const box = $('kpis');
  box.replaceChildren(
    ...tiles.map((t) => {
      const el = h('div', 'kpi');
      el.appendChild(h('span', 'kpi-label', t.label));
      el.appendChild(h('span', `kpi-value${t.long ? ' is-long' : ''}`, t.value));
      el.appendChild(h('span', 'kpi-sub', t.sub));
      return el;
    }),
  );
}

// ------------------------------------------------------------------ filter UI

let optionSignature = { camera: '', lens: '' };

function fillSelect(select, field, rank, allLabel) {
  const opts = [['', allLabel]];
  for (const it of rank.items) opts.push([it.unknown ? NONE : it.key, `${it.label}（${fmt(it.count)}）`]);
  const sig = JSON.stringify(opts);
  if (optionSignature[field] !== sig) {
    optionSignature[field] = sig;
    select.replaceChildren(
      ...opts.map(([v, t]) => {
        const o = h('option', null, t);
        o.value = v;
        return o;
      }),
    );
  }
  select.value = state.filters[field];
}

function renderFilters() {
  const camRank = S.ranking(filtered('camera'), (r) => r.camera, { top: Infinity });
  fillSelect($('f-camera'), 'camera', camRank, `すべてのカメラ（${camRank.distinct}台）`);
  const lensRank = S.ranking(filtered('lens'), (r) => r.lens, { top: Infinity });
  fillSelect($('f-lens'), 'lens', lensRank, `すべてのレンズ（${lensRank.distinct}本）`);

  let lo = Infinity;
  let hi = -Infinity;
  for (const r of state.records) {
    if (r.date == null) continue;
    lo = Math.min(lo, r.date);
    hi = Math.max(hi, r.date);
  }
  const iso = (ts) => new Date(ts).toISOString().slice(0, 10);
  for (const id of ['f-from', 'f-to']) {
    const input = $(id);
    if (lo !== Infinity) {
      input.min = iso(lo);
      input.max = iso(hi);
    }
    input.value = state.filters[id === 'f-from' ? 'from' : 'to'];
  }
  for (const b of $('f-basis').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.value === state.basis));
  }
  $('f-reset').hidden = !filtersActive();
}

// ------------------------------------------------------------------ render

let cardsBuilt = false;

function render() {
  const has = state.records.length > 0;
  $('dashboard').hidden = !has;
  document.querySelector('.intake').classList.toggle('is-compact', has || Boolean(state.scan));
  renderSummary();
  if (!has) return;
  if (!cardsBuilt) {
    $('cards').replaceChildren(...CARDS.map(buildCard));
    cardsBuilt = true;
  }
  renderFilters();
  const recs = filtered();
  renderKpis(recs);
  for (const card of CARDS) renderCard(card, card.id === 'camera' || card.id === 'lens' ? currentRecords(card) : recs);
}

function renderSummary() {
  const box = $('summary');
  const text = $('summary-text');
  const n = state.records.length;
  box.hidden = !n || Boolean(state.scan);
  if (box.hidden) return;
  text.replaceChildren();
  if (state.demo) {
    text.appendChild(h('span', 'demo-badge', 'デモ'));
    text.appendChild(document.createTextNode(`架空の写真 ${fmt(n)}枚を表示しています。自分の写真を読み込むとデモは消えます。`));
    $('export-btn').hidden = true;
    return;
  }
  $('export-btn').hidden = false;
  text.appendChild(h('strong', null, `${fmt(n)}枚`));
  text.appendChild(document.createTextNode('の写真を分析しました。'));
  const c = state.counts;
  const notes = [];
  if (c.noExif) notes.push(`EXIFなし ${fmt(c.noExif)}枚`);
  if (c.failed) notes.push(`読み込めなかったファイル ${fmt(c.failed)}件`);
  if (c.unsupported) notes.push(`画像以外のファイル ${fmt(c.unsupported)}件`);
  if (notes.length) text.appendChild(h('span', 'note', `（${notes.join('・')}は対象外）`));
}

// ------------------------------------------------------------------ intake

function accept(name) {
  return SUPPORTED.test(name) && !name.startsWith('._');
}

function fromFileList(list) {
  return [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

// Must run synchronously inside the drop handler.
function dropSources(dt) {
  const out = [];
  for (const item of dt.items || []) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) out.push({ entry });
    else {
      const f = item.getAsFile();
      if (f) out.push({ file: f, path: f.name });
    }
  }
  if (!out.length) for (const f of dt.files || []) out.push({ file: f, path: f.name });
  return out;
}

async function expandSources(sources) {
  const out = [];
  let lastShown = 0;
  const found = () => {
    const now = performance.now();
    if (now - lastShown > 150) {
      lastShown = now;
      setProgress(`ファイルを探しています… ${fmt(out.length)}件`, null);
    }
  };
  const readAll = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));
  const walk = async (entry) => {
    if (entry.isFile) {
      if (!accept(entry.name)) {
        state.counts.unsupported++;
        return;
      }
      try {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, path: entry.fullPath.replace(/^\//, '') });
        found();
      } catch {
        state.counts.failed++;
      }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        let batch;
        try {
          batch = await readAll(reader);
        } catch {
          break;
        }
        if (!batch.length) break;
        await Promise.all(batch.map(walk));
      }
    }
  };
  for (const s of sources) {
    if (s.entry) await walk(s.entry);
    else out.push(s);
  }
  return out;
}

function hasData(r) {
  return Boolean(r.camera || r.lens || r.focal || r.fnumber || r.exposure || r.iso || r.date != null);
}

const keyOf = (it) => `${it.path}|${it.file.size}|${it.file.lastModified}`;

async function ingest(items) {
  if (state.demo) clearAll();
  const fresh = [];
  let dup = 0;
  for (const it of items) {
    if (!accept(it.file.name)) {
      state.counts.unsupported++;
      continue;
    }
    const key = keyOf(it);
    if (state.seen.has(key)) {
      dup++;
      continue;
    }
    state.seen.add(key);
    fresh.push(it);
  }
  if (!fresh.length) {
    if (!state.scan) hideProgress();
    toast(dup ? 'すでに読み込み済みの写真でした' : '対応する画像ファイルが見つかりませんでした');
    render();
    return;
  }
  if (state.scan) {
    state.scan.queue.push(...fresh);
    state.scan.total += fresh.length;
    return;
  }
  const scan = { queue: fresh, next: 0, done: 0, total: fresh.length, cancelled: false, t0: performance.now() };
  state.scan = scan;
  render();
  updateProgress();

  let lastRender = performance.now();
  const worker = async () => {
    while (!scan.cancelled && scan.next < scan.queue.length) {
      const i = scan.next++;
      const { file, path } = scan.queue[i];
      scan.queue[i] = null;
      try {
        const rec = await readExif(file);
        if (rec && hasData(rec)) {
          rec.path = path;
          state.records.push(rec);
        } else {
          state.counts.noExif++;
        }
      } catch {
        state.counts.failed++;
      }
      scan.done++;
      scheduleProgress();
      const now = performance.now();
      if (now - lastRender > 1500) {
        lastRender = now;
        state.estimated = S.estimateFocal35(state.records);
        render();
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (scan.cancelled) {
    // Let skipped files be picked up again later.
    for (let i = scan.next; i < scan.queue.length; i++) if (scan.queue[i]) state.seen.delete(keyOf(scan.queue[i]));
    toast(`中止しました（${fmt(scan.done)}枚まで分析済み）`);
  }
  state.scan = null;
  hideProgress();
  state.estimated = S.estimateFocal35(state.records);
  render();
  if (!state.records.length && !scan.cancelled) toast('EXIF情報のある写真が見つかりませんでした');
}

// ------------------------------------------------------------------ progress

let progressQueued = false;

function scheduleProgress() {
  if (progressQueued) return;
  progressQueued = true;
  requestAnimationFrame(() => {
    progressQueued = false;
    updateProgress();
  });
}

function updateProgress() {
  const scan = state.scan;
  if (!scan) return;
  const elapsed = (performance.now() - scan.t0) / 1000;
  let eta = '';
  if (scan.done > 20 && elapsed > 2) {
    const rest = ((scan.total - scan.done) * elapsed) / scan.done;
    eta = rest < 60 ? `・残り約${Math.max(1, Math.round(rest))}秒` : `・残り約${Math.round(rest / 60)}分`;
  }
  setProgress(`写真を分析しています… ${fmt(scan.done)} / ${fmt(scan.total)}枚${eta}`, scan.done / scan.total);
}

function setProgress(text, ratio) {
  $('progress').hidden = false;
  $('progress-text').textContent = text;
  $('cancel-btn').hidden = !state.scan;
  $('progress-bar').style.width = ratio == null ? '0%' : `${Math.round(ratio * 1000) / 10}%`;
}

function hideProgress() {
  $('progress').hidden = true;
}

// ------------------------------------------------------------------ misc UI

let toastTimer;

function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', 'toast');
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function clearAll() {
  state.records = [];
  state.seen = new Set();
  state.counts = { noExif: 0, failed: 0, unsupported: 0 };
  state.filters = { camera: '', lens: '', from: '', to: '' };
  state.demo = false;
  optionSignature = { camera: '', lens: '' };
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const recs = filtered();
  const head = [
    'path', 'camera', 'lens', 'focal_length_mm', 'focal_length_35mm', 'focal_35mm_estimated',
    'f_number', 'exposure_time_s', 'shutter', 'iso', 'datetime_original', 'exposure_program',
    'flash_fired', 'exposure_bias_ev',
  ];
  const lines = [head.join(',')];
  for (const r of recs) {
    lines.push(
      [
        r.path, r.camera, r.lens, r.focal, r.focal35, r.focal35Est ? 1 : 0,
        r.fnumber != null ? Math.round(r.fnumber * 100) / 100 : null,
        r.exposure, S.formatShutter(r.exposure), r.iso, S.formatDate(r.date, true),
        r.program != null ? S.PROGRAM_LABELS[r.program] : null,
        r.flash == null ? null : r.flash ? 1 : 0,
        r.bias != null ? Math.round(r.bias * 100) / 100 : null,
      ].map(csvCell).join(','),
    );
  }
  const blob = new Blob(['﻿', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `exif-graph-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function initTheme() {
  const btn = $('theme-toggle');
  const labels = { auto: 'テーマ：自動', light: 'テーマ：ライト', dark: 'テーマ：ダーク' };
  let theme = 'auto';
  try {
    theme = localStorage.getItem(THEME_KEY) || 'auto';
  } catch {
    /* storage unavailable */
  }
  const apply = () => {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    btn.textContent = labels[theme] || labels.auto;
  };
  apply();
  btn.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    theme = order[(order.indexOf(theme) + 1) % order.length];
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
    apply();
  });
}

function initDrop() {
  let depth = 0;
  let overlay = null;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const show = (on) => {
    $('dropzone').classList.toggle('is-over', on);
    if (on && !overlay) {
      overlay = h('div', 'drop-overlay', 'ドロップして写真を読み込む');
      document.body.appendChild(overlay);
    } else if (!on && overlay) {
      overlay.remove();
      overlay = null;
    }
  };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    show(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    const sources = dropSources(e.dataTransfer);
    setProgress('ファイルを探しています…', null);
    expandSources(sources).then(ingest);
  });
}

function initInputs() {
  for (const id of ['pick-folder', 'pick-files']) {
    const input = $(id);
    input.addEventListener('change', () => {
      const items = fromFileList(input.files);
      input.value = '';
      if (items.length) ingest(items);
    });
  }
  $('demo-btn').addEventListener('click', () => {
    if (state.scan) return;
    clearAll();
    state.records = demoRecords();
    state.demo = true;
    render();
    $('dashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('cancel-btn').addEventListener('click', () => {
    if (state.scan) state.scan.cancelled = true;
  });
  $('clear-btn').addEventListener('click', () => {
    clearAll();
    render();
  });
  $('export-btn').addEventListener('click', exportCsv);

  $('f-camera').addEventListener('change', (e) => {
    state.filters.camera = e.target.value;
    keepLensValid();
    render();
  });
  $('f-lens').addEventListener('change', (e) => {
    state.filters.lens = e.target.value;
    render();
  });
  $('f-from').addEventListener('change', (e) => {
    state.filters.from = e.target.value;
    render();
  });
  $('f-to').addEventListener('change', (e) => {
    state.filters.to = e.target.value;
    render();
  });
  $('f-basis').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    state.basis = b.dataset.value;
    render();
  });
  $('f-reset').addEventListener('click', () => {
    state.filters = { camera: '', lens: '', from: '', to: '' };
    render();
  });
}

function initResize() {
  let lastWidth = 0;
  let timer;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (w === lastWidth) return;
    lastWidth = w;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.records.length) render();
    }, 120);
  }).observe($('cards'));
}

initTheme();
initDrop();
initInputs();
initResize();
render();
