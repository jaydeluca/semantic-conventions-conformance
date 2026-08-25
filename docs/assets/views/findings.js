// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Every violation weaver recorded, grouped by kind.
//
// Grouped rather than listed because the distribution is extremely skewed —
// a handful of targets account for most of the total — so a flat list reads
// as one implementation's problem repeated, while the kinds are the actual
// findings: who names spans wrongly, who sets status OK, who emits a metric
// in the wrong unit.
//
// Most of them, though, are absences: weaver records an attribute the
// registry declares and the run did not carry as a violation, so the majority
// of what is here restates a coverage gap. The lede says so, because a
// findings count next to a coverage bar is otherwise the same fact twice.
//
// There is no severity field to sort on. Every finding recorded here is at
// weaver's `violation` level; what distinguishes them is the id.

import { isAbsence } from '../data.js';
import { el, toolbar } from '../ui.js';

export default function findings(data, focus) {
  const groups = [...data.findings.values()].sort(
    (a, b) => b.items.length - a.items.length || a.id.localeCompare(b.id),
  );
  if (!groups.length) {
    return el('div', {}, [
      el('h2', { text: 'Findings' }),
      el('p', { class: 'empty', text: 'No violations recorded anywhere.' }),
    ]);
  }

  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const absent = groups.reduce(
    (sum, group) => sum + (isAbsence(group.id) ? group.items.length : 0),
    0,
  );
  const body = el('div');

  const bar = toolbar({
    search: 'Filter by finding, message, target, or attribute…',
    filters: [
      {
        key: 'kind',
        label: 'Finding',
        options: groups.map((group) => ({
          value: group.id,
          label: `${group.id} (${group.items.length})`,
        })),
      },
      {
        key: 'language',
        label: 'Language',
        options: [...new Set(data.targets.map((t) => t.language))].sort(),
      },
    ],
    onChange: (state) => {
      const shown = groups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => {
            if (state.kind && group.id !== state.kind) return false;
            if (state.language && item.target.language !== state.language) {
              return false;
            }
            if (state.q) {
              const haystack = [
                group.id,
                item.finding.message,
                item.finding.signal_name ?? '',
                item.target.id,
              ]
                .join(' ')
                .toLowerCase();
              if (!haystack.includes(state.q)) return false;
            }
            return true;
          }),
        }))
        .filter((group) => group.items.length);
      body.replaceChildren(
        shown.length
          ? el('div', {}, shown.map((group) => card(group, shown.length === 1)))
          : el('p', { class: 'empty', text: 'Nothing matches those filters.' }),
      );
      const count = shown.reduce((sum, group) => sum + group.items.length, 0);
      return `${count} of ${total}`;
    },
  });

  if (focus) {
    const select = bar.node.querySelector('select');
    if (select) {
      select.value = focus;
      select.dispatchEvent(new Event('change'));
    }
  }

  return el('div', {}, [
    el('h2', { text: 'Findings' }),
    el('p', {
      class: 'lede',
      text:
        `${total} violations across ${groups.length} kinds. ${absent} of ` +
        'them are an attribute, event or metric the registry declares that ' +
        'the run did not carry — the same absence the coverage bars show, ' +
        `counted a second way. The other ${total - absent} are about what ` +
        'did arrive: a wrong unit or type, a span named against the ' +
        'convention, a status the conventions reserve for application code. ' +
        "Every one is at weaver's violation level, so they are grouped by " +
        'kind rather than ranked.',
    }),
    bar.node,
    body,
  ]);
}

function card(group, expanded) {
  const byTarget = new Map();
  for (const item of group.items) {
    if (!byTarget.has(item.target.id)) byTarget.set(item.target.id, []);
    byTarget.get(item.target.id).push(item);
  }
  return el('div', { class: 'card' }, [
    el('h4', {}, [
      el('span', { class: 'finding-id', text: group.id }),
      el('span', {
        class: 'kind',
        text: `${group.items.length} across ${byTarget.size} target${byTarget.size === 1 ? '' : 's'}`,
      }),
    ]),
    ...[...byTarget.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([id, items]) =>
        el('details', { open: expanded && byTarget.size <= 4 }, [
          el('summary', {}, [
            el('a', {
              href: `#/target/${encodeURIComponent(id)}`,
              class: 'mono',
              text: id,
            }),
            el('span', { class: 'ver', text: ` × ${items.length}` }),
          ]),
          ...items.slice(0, 40).map((item) =>
            el('div', { class: 'finding' }, [
              el('span', { class: 'msg', text: item.finding.message }),
              item.finding.signal_name &&
                el('span', {
                  class: 'where',
                  text: `on ${item.finding.signal_type} ${item.finding.signal_name}`,
                }),
            ]),
          ),
          items.length > 40 &&
            el('p', {
              class: 'ver',
              text: `${items.length - 40} more not shown.`,
            }),
        ]),
      ),
  ]);
}
