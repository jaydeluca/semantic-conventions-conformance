// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// The report, inverted: every declared attribute, and who actually emits it.
//
// The question a semantic-convention maintainer has and the individual data
// files cannot answer — which attribute did we write down that nobody
// implements? Worst-adopted first, because that is the working list.
//
// Adoption is out of the targets that emitted the signal at all, not out of
// all of them. An HTTP client attribute is not unadopted because a GenAI
// instrumentation didn't emit it.

import {
  LEVELS,
  LEVEL_LABEL,
  countBy,
  distinguish,
  languageColor,
  levelColor,
} from '../data.js';
import { el, sortableTable, toolbar } from '../ui.js';

/**
 * Labels are only distinguishing within a set, and the set here is the
 * signal's eligible targets — not just its emitters. Deriving them from the
 * emitters instead would let the same target read one way on a well-adopted
 * attribute and another on a thin one, and would disagree with the heatmap,
 * which labels against the whole column set.
 */
const labelCache = new Map();
function labelsFor(row) {
  let found = labelCache.get(row.signal);
  if (!found) {
    found = distinguish(row.eligible);
    labelCache.set(row.signal, found);
  }
  return found;
}

/**
 * Who emitted it: how many, from which ecosystems, and — on request — which.
 *
 * The languages are on the closed row because that is the answer to most of
 * the question. "12 of 17" says an attribute is patchy; "java 10 · python 2"
 * says the gap is somewhere else entirely, and you learn it without opening
 * anything.
 */
function emitters(row, labels) {
  if (row.emitted.length === 0) {
    return el('span', { class: 'ver', text: 'nobody' });
  }
  const languages = countBy(row.emitted.map((target) => target.language));
  const byLanguage = new Map();
  for (const target of row.emitted) {
    if (!byLanguage.has(target.language)) byLanguage.set(target.language, []);
    byLanguage.get(target.language).push(target);
  }

  return el('details', { class: 'who' }, [
    el('summary', {}, [
      row.emitted.length === row.eligible.length
        ? 'everyone'
        : `${row.emitted.length} of ${row.eligible.length}`,
      el(
        'span',
        { class: 'who-langs' },
        [...languages].map(([name, n]) =>
          el('span', {
            class: 'who-tick',
            text: `${name} ${n}`,
            style: `color:${languageColor(name)}`,
          }),
        ),
      ),
    ]),
    el(
      'div',
      { class: 'who-list' },
      [...byLanguage].map(([language, targets]) =>
        el('div', { class: 'who-group' }, [
          // Only worth a gutter when there is something to tell apart; the
          // summary line above already named the language when there is one.
          byLanguage.size > 1 &&
            el('span', {
              class: 'who-lang',
              text: language,
              style: `color:${languageColor(language)}`,
            }),
          el(
            'p',
            { class: 'attrs' },
            targets.map((target) => chip(target, labels.get(target.id))),
          ),
        ]),
      ),
    ),
  ]);
}

function chip(target, label) {
  return el(
    'a',
    {
      href: `#/target/${encodeURIComponent(target.id)}`,
      class: 'mono',
      title: `${label.full} · ${target.instrumentation_library}`,
    },
    [label.primary, label.secondary && el('i', { text: label.secondary })],
  );
}

export default function attributes(data) {
  const rows = data.attributes.map((attribute) => ({
    ...attribute,
    adoption: attribute.eligible.length
      ? attribute.emitted.length / attribute.eligible.length
      : null,
  }));

  const columns = [
    {
      key: 'name',
      label: 'Attribute',
      value: (r) => r.name,
      ascending: true,
      cell: (r) => el('span', { class: 'mono', text: r.name }),
    },
    {
      key: 'signal',
      label: 'On signal',
      value: (r) => r.signal,
      ascending: true,
      cell: (r) =>
        el('a', {
          href: `#/signals/${encodeURIComponent(r.signal)}`,
          class: 'mono',
          text: r.signal,
        }),
    },
    {
      key: 'level',
      label: 'Level',
      value: (r) => LEVELS.indexOf(r.level),
      ascending: true,
      cell: (r) =>
        el('span', { class: 'pill', title: r.level }, [
          el('i', {
            style: `display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:.35rem;background:${levelColor(r.level)}`,
          }),
          LEVEL_LABEL[r.level] ?? r.level,
        ]),
    },
    {
      key: 'adoption',
      label: 'Adoption',
      help: 'Of the targets that emitted this signal at all.',
      value: (r) => r.adoption,
      cell: (r) =>
        el('div', { class: 'bar' }, [
          el('div', { class: 'bar-track' }, [
            el('div', {
              class: 'bar-fill',
              style: `width:${(r.adoption ?? 0) * 100}%;background:${levelColor(r.level)}`,
            }),
          ]),
          el('span', {
            class: 'bar-value',
            text: `${r.emitted.length}/${r.eligible.length}`,
          }),
        ]),
    },
    {
      key: 'who',
      label: 'Emitted by',
      cell: (r) => emitters(r, labelsFor(r)),
    },
  ];

  const table = sortableTable(columns, rows, {
    initial: 'adoption',
    descending: false,
  });

  const bar = toolbar({
    search: 'Filter by attribute or signal…',
    filters: [
      {
        key: 'level',
        label: 'Level',
        options: LEVELS.map((level) => ({
          value: level,
          label: LEVEL_LABEL[level] ?? level,
        })),
      },
      {
        key: 'adoption',
        label: 'Show',
        all: 'Everything',
        options: [
          { value: 'none', label: 'Emitted by nobody' },
          { value: 'partial', label: 'Emitted by some' },
          { value: 'all', label: 'Emitted by everyone' },
        ],
      },
      {
        key: 'signal',
        label: 'Signal',
        options: [...new Set(rows.map((r) => r.signal))].sort(),
      },
    ],
    onChange: (state) => {
      const filtered = rows.filter((r) => {
        if (state.level && r.level !== state.level) return false;
        if (state.signal && r.signal !== state.signal) return false;
        if (state.adoption === 'none' && r.emitted.length !== 0) return false;
        if (
          state.adoption === 'partial' &&
          (r.emitted.length === 0 || r.emitted.length === r.eligible.length)
        ) {
          return false;
        }
        if (
          state.adoption === 'all' &&
          r.emitted.length !== r.eligible.length
        ) {
          return false;
        }
        if (state.q && !`${r.name} ${r.signal}`.toLowerCase().includes(state.q)) {
          return false;
        }
        return true;
      });
      table.redraw(filtered);
      return `${filtered.length} of ${rows.length}`;
    },
  });

  const unadopted = rows.filter(
    (r) => r.level === 'required' && r.emitted.length === 0,
  );

  return el('div', {}, [
    el('h2', { text: 'Attribute adoption' }),
    el('p', {
      class: 'lede',
      text:
        'Every attribute the pinned registries declare on a signal these ' +
        'scenarios emitted, and how many of the instrumentations that emit ' +
        'that signal carried it. Worst adopted first.',
    }),
    unadopted.length > 0
      ? el('div', { class: 'note' }, [
          el('p', {
            html: `<strong>${unadopted.length} required attribute${unadopted.length === 1 ? '' : 's'} that no measured instrumentation emits.</strong>`,
          }),
          el(
            'p',
            { class: 'attrs' },
            unadopted.map((r) =>
              el('code', { text: `${r.name} on ${r.signal}` }),
            ),
          ),
        ])
      : el('div', { class: 'note' }, [
          el('p', {
            text:
              'Every required attribute on every signal measured here is ' +
              'emitted by at least one instrumentation.',
          }),
        ]),
    bar.node,
    table.node,
  ]);
}
