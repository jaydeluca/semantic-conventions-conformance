// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// One signal, every target that emits it, attribute by attribute.
//
// This is the view the individual data files cannot give you. Two
// instrumentations of the same library, or the same instrumentation in four
// languages, are only comparable side by side — and what makes them
// comparable is that the rows are the registry's declaration rather than the
// union of what anyone happened to emit, so an empty column is a real gap and
// not a missing row.

import {
  LEVELS,
  LEVEL_LABEL,
  distinguish,
  fullLabel,
  languageColor,
  levelColor,
} from '../data.js';
import { el, levelLegend, toolbar } from '../ui.js';

/**
 * The signal a route names, and whether it named one that exists.
 *
 * Shared with `title` below so the tab and the heading cannot disagree about
 * which signal is on screen.
 */
function choose(data, key) {
  const available = [...data.signals.values()].sort(
    (a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name),
  );
  const chosen = key ? data.signals.get(key) : undefined;
  return { available, chosen: chosen ?? available[0], unknown: key && !chosen };
}

export function title(data, key) {
  const { chosen } = choose(data, key);
  return chosen ? `${chosen.name} · conformance` : 'signals · conformance';
}

export default function signals(data, key) {
  const { available, chosen, unknown } = choose(data, key);
  if (!available.length) {
    return el('p', { class: 'empty', text: 'No signals in the report.' });
  }

  const body = el('div');
  const bar = toolbar({
    search: 'Filter columns by library or instrumentation…',
    filters: [
      {
        key: 'signal',
        label: 'Signal',
        all: null,
        value: chosen.key,
        options: available.map((signal) => ({
          value: signal.key,
          label: `${signal.name} (${signal.rows.length})`,
        })),
      },
      {
        key: 'level',
        label: 'Levels',
        all: 'All levels',
        options: [
          { value: 'scored', label: 'Required + recommended' },
          { value: 'required', label: 'Required only' },
        ],
      },
      {
        key: 'library',
        label: 'Library',
        options: [
          ...new Set(chosen.rows.map((row) => row.target.instrumented_library)),
        ].sort(),
      },
    ],
    onChange: (state) => {
      if (state.signal && state.signal !== chosen.key) {
        location.hash = `#/signals/${encodeURIComponent(state.signal)}`;
        return '';
      }
      const rows = chosen.rows.filter((row) => {
        if (state.library && row.target.instrumented_library !== state.library) {
          return false;
        }
        if (state.q) {
          const haystack = [
            row.target.instrumented_library,
            row.target.instrumentation_library,
            row.target.language,
            row.target.side ?? '',
          ]
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(state.q)) return false;
        }
        return true;
      });
      const levels =
        state.level === 'required'
          ? ['required']
          : state.level === 'scored'
            ? ['required', 'recommended']
            : LEVELS;
      body.replaceChildren(heatmap(chosen, rows, levels));
      return `${rows.length} target${rows.length === 1 ? '' : 's'}`;
    },
  });

  return el('div', {}, [
    el('h2', {}, [
      'Signal parity: ',
      el('span', { class: 'mono', text: chosen.name }),
    ]),
    // A link can outlive the signal it names — a registry ref that renames one
    // is enough. Say so rather than quietly showing something else, which
    // would read as the link having worked.
    unknown &&
      el('p', { class: 'note' }, [
        el('strong', { text: 'No such signal in this report: ' }),
        el('span', { class: 'mono', text: key }),
        '. Showing ',
        el('span', { class: 'mono', text: chosen.name }),
        ' instead.',
      ]),
    el('p', {
      class: 'lede',
      text:
        `Rows are the ${
          chosen.attributes ? Object.keys(chosen.attributes).length : 0
        } attributes the registry declares on this ${chosen.type}, grouped by ` +
        'requirement level. Columns are every target that emitted it. A blank ' +
        'cell means the attribute was declared and did not arrive.',
    }),
    bar.node,
    body,
  ]);
}

function heatmap(signal, rows, levels) {
  if (!rows.length) {
    return el('p', { class: 'empty', text: 'No targets match those filters.' });
  }
  if (!signal.attributes) {
    return el('p', {
      class: 'empty',
      text:
        'The registry does not declare this signal, so there is nothing to ' +
        'compare against.',
    });
  }

  const columns = rows.slice().sort(compareColumns);
  const labels = distinguish(columns.map((row) => row.target));
  const header = el('tr', {}, [
    el('th', { class: 'attr', scope: 'col', text: 'Attribute' }),
    ...columns.map((row) => columnHeader(row.target, labels.get(row.target.id))),
    el('th', { class: 'tally', scope: 'col', text: 'emitted by' }),
  ]);

  const body = el('tbody');
  const grouped = new Map(levels.map((level) => [level, []]));
  for (const [attribute, level] of Object.entries(signal.attributes)) {
    if (grouped.has(level)) grouped.get(level).push(attribute);
  }

  let drawn = 0;
  for (const level of levels) {
    const attributes = (grouped.get(level) ?? []).sort();
    if (!attributes.length) continue;
    body.append(
      el('tr', { class: 'level-head' }, [
        el('th', { colspan: columns.length + 2, scope: 'colgroup' }, [
          el('i', {
            style: `display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:.4rem;background:${levelColor(level)}`,
          }),
          `${LEVEL_LABEL[level] ?? level} · ${attributes.length}`,
        ]),
      ]),
    );
    for (const attribute of attributes) {
      const emitted = columns.map((row) => row.signal.emitted.includes(attribute));
      const count = emitted.filter(Boolean).length;
      body.append(
        el('tr', {}, [
          el('th', { class: 'attr', scope: 'row', text: attribute }),
          ...emitted.map((yes, i) =>
            el('td', { class: `cell ${yes ? 'cell-yes' : 'cell-no'}` }, [
              el('span', {
                text: yes ? '•' : '',
                title: `${fullLabel(columns[i].target)} ${yes ? 'emits' : 'does not emit'} ${attribute}`,
              }),
            ]),
          ),
          el('td', {
            class: 'num rowcount',
            text: `${count}/${columns.length}`,
          }),
        ]),
      );
      drawn += 1;
    }
  }

  if (!drawn) {
    return el('p', {
      class: 'empty',
      text: 'This signal declares no attributes at the selected levels.',
    });
  }

  const bands = languageBands(columns);
  return el('div', {}, [
    caption(columns),
    el('div', { class: 'scroller fit' }, [
      el('table', { class: `heatmap${bands ? ' banded' : ''}` }, [
        el('thead', {}, [bands, header]),
        body,
      ]),
    ]),
    levelLegend(levels),
  ]);
}

/**
 * One column header: the library, and only what else is needed to tell it
 * from its neighbours.
 *
 * Two lines rather than one string, because the header is rotated — stacked,
 * the height is set by the longer line instead of by their sum, which is what
 * keeps a 23-character instrumentation name inside the band instead of
 * clipped by it. Not a link yet: there is no target page for it to reach, and
 * a header that re-rendered this same view would read as a bug.
 */
function columnHeader(target, label) {
  const full = `${label.full} · ${target.instrumentation_library}`;
  const colour = languageColor(target.language);
  return el('th', {
    class: 'col',
    scope: 'col',
    // Carried down from the band so a column keeps its language where the
    // reader's eye actually is: at the bottom of the header, against the grid.
    style: `box-shadow: inset 0 -2px 0 ${colour}`,
  }, [
    el(
      'span',
      {
        title: full,
        'aria-label': full,
      },
      [
        el('b', { text: label.primary }),
        label.secondary && el('i', { text: label.secondary }),
      ],
    ),
  ]);
}

/**
 * A band naming each language over the columns it covers.
 *
 * Null when they are all one language: a band that says the same thing about
 * every column is a row of chrome, and the caption already said it.
 */
function languageBands(columns) {
  const groups = [];
  for (const row of columns) {
    const last = groups.at(-1);
    if (last && last.language === row.target.language) last.span += 1;
    else groups.push({ language: row.target.language, span: 1 });
  }
  if (groups.length < 2) return null;
  return el('tr', { class: 'band' }, [
    el('th', { class: 'attr', scope: 'col' }),
    ...groups.map((group) => {
      const colour = languageColor(group.language);
      return el('th', {
        class: 'band-cell',
        scope: 'colgroup',
        colspan: group.span,
        text: group.language,
        style:
          `color:${colour};` +
          `background:color-mix(in srgb, ${colour} 10%, var(--surface-2));` +
          `box-shadow: inset 0 2px 0 ${colour}`,
      });
    }),
    el('th', { class: 'tally', scope: 'col' }),
  ]);
}

/**
 * What every column has in common, said once.
 *
 * This is where the parts the labels stopped printing go. Only genuinely
 * constant fields are named, so the line can be read as a fact about the
 * whole table rather than about most of it.
 */
function caption(columns) {
  const shared = (pick) => {
    const values = new Set(columns.map((row) => pick(row.target)));
    return values.size === 1 ? [...values][0] : null;
  };
  const language = shared((t) => t.language);
  const side = shared((t) => t.side);
  const instrumentation = shared((t) => t.instrumentation_library);

  const parts = [`${columns.length} column${columns.length === 1 ? '' : 's'}`];
  if (language) parts.push(`every one ${language}`);
  if (side) parts.push(`every one ${side}-side`);
  if (instrumentation) parts.push(`all through ${instrumentation}`);
  return el('p', { class: 'caption', text: parts.join(' · ') });
}

/**
 * Group the columns the way a reader compares them: language-major, then
 * same library adjacent.
 *
 * Language leads so the band above the header has something contiguous to
 * name, and it costs nothing — a library is effectively single-language here,
 * so the pairs worth comparing side by side stay side by side.
 */
function compareColumns(a, b) {
  return (
    a.target.language.localeCompare(b.target.language) ||
    a.target.instrumented_library.localeCompare(b.target.instrumented_library) ||
    a.target.short.localeCompare(b.target.short) ||
    (a.target.side ?? '').localeCompare(b.target.side ?? '')
  );
}
