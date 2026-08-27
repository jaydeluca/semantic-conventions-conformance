// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// The pieces every view draws with.
//
// Deliberately small and hand-rolled: every visualization this report needs
// is a table, a proportional bar, a grid of cells, or a line — so a charting
// library would be a dependency tree bought for arithmetic that fits here.

import { LEVELS, LEVEL_LABEL, levelColor } from './data.js';

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
