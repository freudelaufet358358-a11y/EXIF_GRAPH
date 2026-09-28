// Small SVG/HTML chart kit: column chart, ranked bar list, heatmap, table.
// Colours come from CSS custom properties, so theme changes need no redraw.
// Labels are always inserted with textContent (file-derived strings).

import { fmt, pct } from './stats.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const FONT = 'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif';

function s(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

export function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

let ctx;
function textWidth(str, size = 11, weight = 400) {
  ctx ??= document.createElement('canvas').getContext('2d');
  ctx.font = `${weight} ${size}px ${FONT}`;
  return ctx.measureText(str).width;
}

function niceTicks(max, target = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  step = Math.max(1, Math.round(step));
  const ticks = [];
  for (let v = 0; v < max + step; v += step) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

// Column with a 4px rounded data-end and a square baseline.
function colPath(x, y, w, hgt, r) {
  r = Math.max(0, Math.min(r, w / 2, hgt));
  return `M${x},${y + hgt}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + hgt}Z`;
}

// ------------------------------------------------------------------ tooltip

function makeTooltip(host) {
  const tip = h('div', 'tip');
  tip.setAttribute('role', 'status');
  tip.hidden = true;
  host.appendChild(tip);
  return {
    show(lines, x, y) {
      tip.replaceChildren();
      const [value, ...rest] = lines;
      const v = h('div', 'tip-value');
      v.appendChild(h('strong', null, value.main));
      if (value.aside) v.appendChild(h('span', 'tip-aside', value.aside));
      tip.appendChild(v);
      for (const line of rest) tip.appendChild(h('div', 'tip-label', line));
      tip.hidden = false;
      const hw = host.clientWidth;
      const tw = tip.offsetWidth;
      const left = Math.max(0, Math.min(hw - tw, x - tw / 2));
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

// ------------------------------------------------------------------ columns

// items: [{ key, label, sub?, count }]
// opts:  { total, unit, ariaLabel, describe?(item) -> extra tooltip line }
export function columnChart(host, items, opts = {}) {
  host.replaceChildren();
  host.classList.add('chart');
  const total = opts.total ?? items.reduce((a, b) => a + b.count, 0);
  const unit = opts.unit ?? '枚';
  const width = Math.max(260, host.clientWidth || 600);
  const plotH = width < 520 ? 170 : 210;
  const n = items.length;
  const max = Math.max(1, ...items.map((i) => i.count));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const tickW = Math.max(...ticks.map((t) => textWidth(fmt(t))));
  const hasSub = items.some((i) => i.sub);
  const m = { t: 22, r: 6, b: hasSub ? 40 : 26, l: Math.ceil(tickW) + 10 };
  const W = width;
  const H = m.t + plotH + m.b;
  const pw = W - m.l - m.r;
  const band = pw / Math.max(1, n);
  const barW = Math.max(1, Math.min(24, band * 0.72, band - 2));
  const y = (v) => m.t + plotH - (v / top) * plotH;
  const cx = (i) => m.l + band * (i + 0.5);

  const svg = s('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    class: 'viz',
    role: 'img',
    'aria-label': opts.ariaLabel || '',
  });

  // Grid and y ticks (hairline, recessive).
  for (const t of ticks) {
    s('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }, svg);
    const tx = s('text', { x: m.l - 8, y: y(t), dy: '0.32em', 'text-anchor': 'end', class: 'tick' }, svg);
    tx.textContent = fmt(t);
  }

  const wash = s('rect', { class: 'wash', y: m.t, height: plotH, width: band, x: 0, visibility: 'hidden' }, svg);

  let maxIdx = 0;
  items.forEach((it, i) => {
    if (it.count > items[maxIdx].count) maxIdx = i;
  });

  const bars = items.map((it, i) => {
    if (!it.count) return null;
    const hgt = (it.count / top) * plotH;
    return s('path', { d: colPath(cx(i) - barW / 2, y(it.count), barW, hgt, 4), class: 'bar' }, svg);
  });

  // Direct label: the extreme only.
  if (items[maxIdx]?.count) {
    const t = s('text', { x: cx(maxIdx), y: y(items[maxIdx].count) - 6, 'text-anchor': 'middle', class: 'dlabel' }, svg);
    t.textContent = fmt(items[maxIdx].count);
  }

  // X labels: evenly thinned, the tallest bar always labelled, never overlapping.
  const widths = items.map((it) => textWidth(it.label));
  const avg = widths.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const step = Math.max(1, Math.ceil((avg + 10) / band));
  const placed = [];
  const fits = (i) => {
    const a = cx(i) - widths[i] / 2 - 5;
    const b = cx(i) + widths[i] / 2 + 5;
    if (a < 0 || b > W) return false;
    return placed.every(([pa, pb]) => b <= pa || a >= pb);
  };
  const order = [maxIdx, ...items.map((_, i) => i).filter((i) => i % step === 0 && i !== maxIdx)];
  const shown = new Set();
  for (const i of order) {
    if (!fits(i)) continue;
    placed.push([cx(i) - widths[i] / 2 - 5, cx(i) + widths[i] / 2 + 5]);
    shown.add(i);
  }
  const allShown = shown.size === n;
  for (const i of shown) {
    const t = s('text', { x: cx(i), y: m.t + plotH + 16, 'text-anchor': 'middle', class: 'xlabel' }, svg);
    t.textContent = items[i].label;
    if (hasSub && allShown && items[i].sub && textWidth(items[i].sub, 10) < band - 2) {
      const st = s('text', { x: cx(i), y: m.t + plotH + 30, 'text-anchor': 'middle', class: 'xsub' }, svg);
      st.textContent = items[i].sub;
    }
  }

  host.appendChild(svg);
  const tip = makeTooltip(host);

  let active = -1;
  const setActive = (i) => {
    if (active >= 0 && bars[active]) bars[active].classList.remove('is-active');
    active = i;
    if (i < 0) {
      wash.setAttribute('visibility', 'hidden');
      tip.hide();
      return;
    }
    const it = items[i];
    wash.setAttribute('x', m.l + band * i);
    wash.setAttribute('visibility', 'visible');
    if (bars[i]) bars[i].classList.add('is-active');
    const lines = [{ main: `${fmt(it.count)}${unit}`, aside: pct(it.count, total) }];
    lines.push(it.sub ? `${it.label}（${it.sub}）` : it.title || it.label);
    const extra = opts.describe?.(it);
    if (extra) lines.push(extra);
    tip.show(lines, cx(i), y(it.count));
  };

  // Hit targets: the whole band, not just the painted bar.
  const hit = s('rect', { x: m.l, y: 0, width: pw, height: m.t + plotH + 18, class: 'hit' }, svg);
  const indexAt = (ev) => {
    const r = svg.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(n - 1, Math.floor((x - m.l) / band)));
  };
  hit.addEventListener('pointermove', (ev) => {
    const i = indexAt(ev);
    if (i !== active) setActive(i);
  });
  hit.addEventListener('pointerleave', () => setActive(-1));

  // Keyboard: arrow keys walk the bars, same readout as hover.
  host.tabIndex = 0;
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', `${opts.ariaLabel || ''}（矢印キーで各値を確認）`);
  host.onkeydown = (ev) => {
    if (!n) return;
    let i = active;
    if (ev.key === 'ArrowRight') i = Math.min(n - 1, active < 0 ? 0 : active + 1);
    else if (ev.key === 'ArrowLeft') i = Math.max(0, active < 0 ? n - 1 : active - 1);
    else if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = n - 1;
    else if (ev.key === 'Escape') i = -1;
    else return;
    ev.preventDefault();
    setActive(i);
  };
  host.onblur = () => setActive(-1);
}

// ------------------------------------------------------------------ bar list

// Ranked horizontal bars for categories with long names (camera, lens).
// items: [{ key, label, count, other?, unknown? }]
// opts:  { total, unit, onSelect?(item), selectedKey }
export function barList(host, items, opts = {}) {
  host.replaceChildren();
  host.classList.remove('chart');
  host.removeAttribute('tabindex');
  host.onkeydown = null;
  host.onblur = null;
  const total = opts.total ?? items.reduce((a, b) => a + b.count, 0);
  const unit = opts.unit ?? '枚';
  const max = Math.max(1, ...items.map((i) => i.count));
  const list = h('ol', 'barlist');
  for (const it of items) {
    const li = h('li');
    const clickable = opts.onSelect && !it.other;
    const row = h(clickable ? 'button' : 'div', 'barrow');
    if (clickable) {
      row.type = 'button';
      const selected = opts.selectedKey != null && opts.selectedKey === it.key;
      row.setAttribute('aria-pressed', String(selected));
      row.title = selected ? `「${it.label}」の絞り込みを解除` : `「${it.label}」で絞り込む`;
      row.addEventListener('click', () => opts.onSelect(it));
    }
    const label = h('span', 'barrow-label', it.label);
    label.title = it.label;
    const line = h('span', 'barrow-line');
    const bar = h('span', 'barrow-bar');
    if (it.other || it.unknown) bar.classList.add('is-muted');
    bar.style.setProperty('--w', String(it.count / max));
    const value = h('span', 'barrow-value');
    value.appendChild(h('strong', null, `${fmt(it.count)}${unit}`));
    value.appendChild(h('span', null, pct(it.count, total)));
    line.append(bar, value);
    row.append(label, line);
    li.appendChild(row);
    list.appendChild(li);
  }
  host.appendChild(list);
}

// ------------------------------------------------------------------ heatmap

export const HEAT_STEPS = 7;

export function heatStep(count, max) {
  if (!count) return 0;
  return Math.max(1, Math.min(HEAT_STEPS, Math.ceil((count / max) * HEAT_STEPS)));
}

// m: { rows:[{key,label,sub}], cols:[{key,label}], cells: Map("r:c" -> n), max, counted }
export function heatmap(host, m, opts = {}) {
  host.replaceChildren();
  host.classList.add('chart');
  host.removeAttribute('tabindex');
  host.onkeydown = null;
  host.onblur = null;
  const total = m.counted;
  const grid = h('div', 'heat');
  grid.style.setProperty('--cols', String(m.cols.length));
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', opts.ariaLabel || '');

  const width = host.clientWidth || 600;
  const labelW = width < 520 ? 76 : 110;
  const cellW = (width - labelW) / Math.max(1, m.cols.length);
  const showCounts = cellW >= 34;
  grid.style.setProperty('--label-w', `${labelW}px`);

  grid.appendChild(h('div', 'heat-corner', opts.corner || ''));
  for (const c of m.cols) grid.appendChild(h('div', 'heat-col', c.label));

  const tip = makeTooltip(host);
  for (const r of m.rows) {
    const rl = h('div', 'heat-row');
    rl.appendChild(h('span', 'heat-row-label', r.label));
    if (r.sub && width >= 520) rl.appendChild(h('span', 'heat-row-sub', r.sub));
    grid.appendChild(rl);
    for (const c of m.cols) {
      const count = m.cells.get(`${r.key}:${c.key}`) || 0;
      const step = heatStep(count, m.max);
      const cell = h('div', `heat-cell s${step}`);
      if (count && showCounts) cell.textContent = fmt(count);
      if (count) {
        cell.addEventListener('pointerenter', () => {
          const hr = host.getBoundingClientRect();
          const cr = cell.getBoundingClientRect();
          tip.show(
            [{ main: `${fmt(count)}枚`, aside: pct(count, total) }, `${r.label}${r.sub ? `（${r.sub}）` : ''} × ${c.label}`],
            cr.left - hr.left + cr.width / 2,
            cr.top - hr.top,
          );
          cell.classList.add('is-active');
        });
        cell.addEventListener('pointerleave', () => {
          tip.hide();
          cell.classList.remove('is-active');
        });
      }
      grid.appendChild(cell);
    }
  }
  host.appendChild(grid);

  // Scale legend (sequential, one hue).
  const legend = h('div', 'heat-legend');
  legend.appendChild(h('span', 'heat-legend-end', '少'));
  const sw = h('span', 'heat-legend-swatches');
  for (let i = 1; i <= HEAT_STEPS; i++) sw.appendChild(h('span', `heat-swatch s${i}`));
  legend.appendChild(sw);
  legend.appendChild(h('span', 'heat-legend-end', `多（最大 ${fmt(m.max)}枚）`));
  host.appendChild(legend);
}

// ------------------------------------------------------------------ table

// columns: [{ label, num? }], rows: [[cell, ...]]
export function dataTable(host, columns, rows, caption) {
  host.replaceChildren();
  const wrap = h('div', 'table-wrap');
  const t = h('table', 'data-table');
  if (caption) t.appendChild(h('caption', null, caption));
  const thead = h('thead');
  const tr = h('tr');
  for (const c of columns) {
    const th = h('th', c.num ? 'num' : null, c.label);
    th.scope = 'col';
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  t.appendChild(thead);
  const tbody = h('tbody');
  for (const row of rows) {
    const r = h('tr');
    row.forEach((cell, i) => r.appendChild(h('td', columns[i].num ? 'num' : null, String(cell))));
    tbody.appendChild(r);
  }
  t.appendChild(tbody);
  wrap.appendChild(t);
  host.appendChild(wrap);
}
