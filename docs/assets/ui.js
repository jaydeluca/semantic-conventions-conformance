// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// The pieces every view draws with.
//
// Deliberately small and hand-rolled: every visualization this report needs
// is a table, a proportional bar, a grid of cells, or a line — so a charting
// library would be a dependency tree bought for arithmetic that fits here.

import { LEVELS, LEVEL_LABEL, levelColor } from './data.js';

/**
 * Build an element. `attrs` may carry `class`, `text`, or events.
 *
 * No `html` escape hatch on purpose: every string this module renders comes
 * from the report, which carries registry-authored names, and one convenience
 * key is not worth being the only place that could hand them to a parser.
 * Nest a child element instead.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
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

/**
 * A search box plus select filters, calling back on any change.
 *
 * A filter may name its own starting `value`, and may pass `all: null` to say
 * it has no all-state — a selector whose choice the view below cannot do
 * without. Between them a caller says where a control opens up front, rather
 * than reaching back into the DOM for it afterwards and selecting by position.
 */
export function toolbar({ search, filters = [], onChange }) {
  const state = {
    q: '',
    ...Object.fromEntries(filters.map((f) => [f.key, f.value ?? ''])),
  };
  const count = el('span', { class: 'count' });

  const emit = () => {
    count.textContent = onChange({ ...state }) ?? '';
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

  const controls = filters.map((filter) => {
    const select = el(
      'select',
      {
        'aria-label': filter.label,
        onchange: (event) => {
          state[filter.key] = event.target.value;
          emit();
        },
      },
      [
        // `all: null` means there is no all-state to offer. Rendering the
        // option anyway would name a state the view cannot draw, and leave
        // the control disagreeing with the table under it.
        filter.all === null
          ? null
          : el('option', { value: '', text: filter.all ?? 'All' }),
        ...filter.options.map((option) =>
          el('option', {
            value: option.value ?? option,
            text: option.label ?? option,
          }),
        ),
      ],
    );
    // Start the control and `state` in agreement. A filter with no all-state
    // opens on whatever the caller named, and on its first option when the
    // caller named nothing the list holds.
    select.value = state[filter.key];
    if (select.selectedIndex < 0) select.selectedIndex = 0;
    state[filter.key] = select.value;
    return el('label', {}, [filter.label, select]);
  });

  const node = el('div', { class: 'toolbar' }, [input, controls, count]);
  emit();
  return { node, state };
}
