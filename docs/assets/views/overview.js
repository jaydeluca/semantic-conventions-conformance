// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Every target, one row each. The way in to everything else.

import { languageColor, ratio, scoreOf } from '../data.js';
import { coverageBar, el, sortableTable, toolbar } from '../ui.js';

const REPO = 'https://github.com/open-telemetry/semantic-conventions-conformance';

const unique = (values) => [...new Set(values)].sort();

export default function overview(data) {
  const columns = [
    {
      key: 'target',
      label: 'Instrumented library',
      value: (t) => `${t.library ?? t.id}`,
      ascending: true,
      cell: (t) =>
        el('div', {}, [
          el('a', {
            href: `#/target/${encodeURIComponent(t.id)}`,
            class: 'mono',
            text: libraryOf(t),
          }),
          t.side && el('span', { class: 'ver', text: ` ${t.side}` }),
        ]),
    },
    {
      key: 'instrumentation',
      label: 'Instrumentation',
      value: (t) => t.short,
      ascending: true,
      cell: (t) =>
        el('div', {}, [
          el('span', { class: 'mono', text: t.short, title: t.instrumentation_library }),
          t.versions?.instrumentation &&
            el('span', { class: 'ver', text: ` ${t.versions.instrumentation}` }),
        ]),
    },
    {
      key: 'language',
      label: 'Language',
      value: (t) => t.language,
      ascending: true,
      cell: (t) => {
        const colour = languageColor(t.language);
        return el('span', {
          class: 'pill lang',
          text: t.language,
          style:
            `color:${colour};` +
            `border-color:color-mix(in srgb, ${colour} 35%, transparent);` +
            `background:color-mix(in srgb, ${colour} 9%, var(--surface))`,
        });
      },
    },
    {
      key: 'required',
      label: 'Required',
      help: 'Declared attributes at requirement level `required` that the run carried.',
      value: (t) => ratio(scoreOf(t, 'required')),
      cell: (t) => coverageBar(scoreOf(t, 'required'), 'required'),
    },
    {
      key: 'recommended',
      label: 'Recommended',
      help:
        'Declared attributes at requirement level `recommended` that the run ' +
        'carried. Scored apart from required: an instrumentation may have ' +
        'had nothing to put there.',
      value: (t) => ratio(scoreOf(t, 'recommended')),
      cell: (t) => coverageBar(scoreOf(t, 'recommended'), 'recommended'),
    },
    {
      key: 'findings',
      label: 'Findings',
      help: 'Weaver violations recorded on this run.',
      numeric: true,
      value: (t) => t.summary.findings,
      cell: (t) =>
        t.summary.findings
          ? el('a', {
              href: `#/target/${encodeURIComponent(t.id)}`,
              text: String(t.summary.findings),
            })
          : el('span', { class: 'ver', text: '—' }),
    },
  ];

  const table = sortableTable(columns, data.targets, { initial: 'recommended', descending: false });

  const bar = toolbar({
    search: 'Filter by library, instrumentation, or language…',
    filters: [
      { key: 'domain', label: 'Domain', options: unique(data.targets.map((t) => t.domain)) },
      { key: 'language', label: 'Language', options: unique(data.targets.map((t) => t.language)) },
      {
        key: 'state',
        label: 'Show',
        all: 'Everything',
        options: [
          { value: 'findings', label: 'With findings' },
          { value: 'clean', label: 'No findings' },
          { value: 'gaps', label: 'Missing something required' },
        ],
      },
    ],
    onChange: (state) => {
      const rows = data.targets.filter((t) => {
        if (state.domain && t.domain !== state.domain) return false;
        if (state.language && t.language !== state.language) return false;
        if (state.state === 'findings' && !t.summary.findings) return false;
        if (state.state === 'clean' && t.summary.findings) return false;
        if (state.state === 'gaps') {
          const required = scoreOf(t, 'required');
          if (required.emitted >= required.declared) return false;
        }
        if (state.q) {
          const haystack = [
            t.id,
            t.instrumented_library,
            t.instrumentation_library,
            t.language,
            t.short,
          ]
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(state.q)) return false;
        }
        return true;
      });
      table.redraw(rows);
      return `${rows.length} of ${data.targets.length}`;
    },
  });

  return el('div', {}, [
    el('h2', { text: 'Targets' }),
    el('p', { class: 'lede' }, [
      'One row per conformance directory: a library, the instrumentation ' +
        'measured against it, and how much of what the registry declares for ' +
        'the signals it emitted actually arrived. Only ',
      el('code', { text: 'required' }),
      ' and ',
      el('code', { text: 'recommended' }),
      ' are scored — an absence at the other three requirement levels is not ' +
        'a gap, so there is no single conformance number here. ',
      el('a', { href: `${REPO}/blob/main/tools/report/README.md`, text: 'How to read these numbers', rel: 'noreferrer' }),
      '.',
    ]),
    bar.node,
    table.node,
  ]);
}

/** The instrumented library, which is what a reader is scanning for. */
export function libraryOf(target) {
  return target.instrumented_library;
}
