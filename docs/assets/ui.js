// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// The pieces every view draws with.
//
// Deliberately small and hand-rolled: every visualization this report needs
// is a table, a proportional bar, a grid of cells, or a line — so a charting
// library would be a dependency tree bought for arithmetic that fits here.

import { LEVELS, LEVEL_LABEL, levelColor, ratio } from './data.js';

/** Build an element. `attrs` may carry `class`, `text`, `html`, or events. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [children].flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const frag = (children) => {
  const f = document.createDocumentFragment();
  for (const child of [children].flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    f.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return f;
};

/** A proportional bar for one scored level. */
export function coverageBar(tally, level) {
  const value = ratio(tally);
  if (value === null) {
    return el('div', { class: 'bar na' }, [
      el('span', { class: 'bar-value', text: 'n/a' }),
    ]);
  }
  return el('div', { class: 'bar', title: `${tally.emitted} of ${tally.declared} ${level}` }, [
    el('div', { class: 'bar-track' }, [
      el('div', {
        class: `bar-fill ${level}`,
        style: `width:${value * 100}%`,
      }),
    ]),
    el('span', {
      class: 'bar-value',
      text: `${tally.emitted}/${tally.declared}`,
    }),
  ]);
}

/**
 * Every requirement level in one bar, emitted portion solid.
 *
 * Shown alongside the scored levels rather than instead of them: the whole
 * shape of what a registry declares is worth seeing, and it is also why a
 * single blended number would mislead — most of the width is usually opt-in.
 */
export function levelBar(coverage) {
  const total = Object.values(coverage).reduce((sum, t) => sum + t.declared, 0);
  if (!total) return el('div', { class: 'levels' });
  return el(
    'div',
    { class: 'levels' },
    LEVELS.filter((level) => coverage[level]).flatMap((level) => {
      const tally = coverage[level];
      const missed = tally.declared - tally.emitted;
      return [
        tally.emitted > 0 &&
          el('span', {
            style: `width:${(tally.emitted / total) * 100}%;background:${levelColor(level)}`,
            title: `${tally.emitted} ${LEVEL_LABEL[level] ?? level} emitted`,
          }),
        missed > 0 &&
          el('span', {
            style: `width:${(missed / total) * 100}%;background:color-mix(in srgb, ${levelColor(level)} 22%, transparent)`,
            title: `${missed} ${LEVEL_LABEL[level] ?? level} not emitted`,
          }),
      ];
    }),
  );
}

export function levelLegend(levels = LEVELS) {
  return el(
    'p',
    { class: 'legend' },
    levels.map((level) =>
      el('span', {}, [
        el('i', { style: `background:${levelColor(level)}` }),
        LEVEL_LABEL[level] ?? level,
      ]),
    ),
  );
}

/** A table whose header cells sort it. `columns[].value` gives a sort key. */
export function sortableTable(columns, rows, { initial, descending = true } = {}) {
  let sortKey = initial ?? columns[0].key;
  let desc = descending;

  const body = el('tbody');
  const head = el('tr');
  const headers = new Map();

  const draw = () => {
    const column = columns.find((c) => c.key === sortKey) ?? columns[0];
    const sorted = [...rows].sort((a, b) => {
      const left = column.value ? column.value(a) : 0;
      const right = column.value ? column.value(b) : 0;
      if (left === right) {
        const fallback = columns[0].value?.(a) ?? '';
        const other = columns[0].value?.(b) ?? '';
        return String(fallback).localeCompare(String(other));
      }
      // Nulls last, whichever way the column is pointing.
      if (left === null) return 1;
      if (right === null) return -1;
      const order = typeof left === 'string' ? String(left).localeCompare(String(right)) : left - right;
      return desc ? -order : order;
    });
    body.replaceChildren(
      ...sorted.map((row) =>
        el(
          'tr',
          {},
          columns.map((c) => el('td', { class: c.numeric ? 'num' : null }, [c.cell(row)])),
        ),
      ),
    );
    for (const [key, th] of headers) {
      if (key === sortKey) th.setAttribute('aria-sort', desc ? 'descending' : 'ascending');
      else th.removeAttribute('aria-sort');
    }
  };

  for (const column of columns) {
    const th = el('th', {
      class: column.value ? 'sortable' : null,
      scope: 'col',
      text: column.label,
      title: column.help,
    });
    if (column.value) {
      th.addEventListener('click', () => {
        if (sortKey === column.key) desc = !desc;
        else {
          sortKey = column.key;
          desc = column.ascending !== true;
        }
        draw();
      });
    }
    headers.set(column.key, th);
    head.append(th);
  }

  draw();
  return {
    node: el('div', { class: 'scroller' }, [
      el('table', {}, [el('thead', {}, [head]), body]),
    ]),
    redraw(next) {
      rows = next;
      draw();
    },
  };
}

/** A search box plus select filters, calling back on any change. */
export function toolbar({ search, filters = [], onChange, summary }) {
  const state = { q: '', ...Object.fromEntries(filters.map((f) => [f.key, ''])) };
  const count = el('span', { class: 'count' });

  const emit = () => {
    const label = onChange({ ...state });
    if (summary !== false) count.textContent = label ?? '';
  };

  const input = el('input', {
    type: 'search',
    placeholder: search ?? 'Search…',
    'aria-label': search ?? 'Search',
    oninput: (event) => {
      state.q = event.target.value.trim().toLowerCase();
      emit();
    },
  });

  const controls = filters.map((filter) =>
    el('label', {}, [
      filter.label,
      el(
        'select',
        {
          'aria-label': filter.label,
          onchange: (event) => {
            state[filter.key] = event.target.value;
            emit();
          },
        },
        [
          el('option', { value: '', text: filter.all ?? 'All' }),
          ...filter.options.map((option) =>
            el('option', {
              value: option.value ?? option,
              text: option.label ?? option,
            }),
          ),
        ],
      ),
    ]),
  );

  const node = el('div', { class: 'toolbar' }, [input, controls, count]);
  emit();
  return { node, state };
}

export const link = (href, text, attrs = {}) => el('a', { href, text, ...attrs });
