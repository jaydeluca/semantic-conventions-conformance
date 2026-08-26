// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// One conformance directory, in full: what each signal carried, what it
// didn't, and every violation weaver recorded.

import { LEVELS, LEVEL_LABEL, isAbsence, scoreOf } from '../data.js';
import { coverageBar, el, levelBar } from '../ui.js';

const REPO = 'https://github.com/open-telemetry/semantic-conventions-conformance';

// Why a level is or isn't part of the two scores above. Only the scored pair
// can be read as a shortfall; the rest are counts, so the tooltip says so
// rather than repeating the label the reader can already see.
const LEVEL_NOTE = {
  required: 'Scored. An absence here is a gap.',
  recommended: 'Scored. An absence is usually a gap.',
  conditionally_required_conditional:
    'Counted, not scored — whether the condition held is not in the data.',
  recommended_conditional:
    'Counted, not scored — whether the condition held is not in the data.',
  opt_in: 'Counted, not scored — off by default is the correct behaviour.',
};

export default function target(data, id) {
  const found = data.byId.get(id);
  if (!found) {
    return el('div', {}, [
      el('p', { class: 'empty', text: `No target called ${id}.` }),
      el('p', {}, [el('a', { href: '#/', text: '← every target' })]),
    ]);
  }

  return el('div', {}, [
    el('p', { class: 'crumbs' }, [
      el('a', { href: '#/', text: 'Targets' }),
      ' / ',
      found.domain,
      ' / ',
      found.language,
    ]),
    el('h2', {}, [
      el('span', { class: 'mono', text: found.instrumented_library }),
      ' through ',
      el('span', { class: 'mono', text: found.short }),
      found.side && el('span', { class: 'ver', text: ` (${found.side})` }),
    ]),
    facts(found),
    scores(found),
    ...found.signals
      .slice()
      .sort(byInterest)
      .map((signal) => signalCard(found, signal)),
    entities(data, found),
    findings(found),
  ]);
}

/** Spans first, then events, then metrics; within a kind, most gaps first. */
function byInterest(a, b) {
  const rank = { span: 0, event: 1, metric: 2 };
  if (rank[a.type] !== rank[b.type]) return rank[a.type] - rank[b.type];
  return (b.missing?.length ?? 0) - (a.missing?.length ?? 0);
}

function facts(found) {
  const pin = found.runner;
  const rows = [
    ['Instrumented library', found.instrumented_library, found.versions?.instrumented],
    ['Instrumentation', found.instrumentation_library, found.versions?.instrumentation],
    ['Domain', `${found.domain} (${pin})`, null],
    ['Language', found.language, null],
    [
      'Scenarios exercised',
      found.scenario_classes.join(', ') || '—',
      null,
    ],
  ];
  return el('dl', { class: 'facts' }, [
    ...rows.flatMap(([label, value, version]) => [
      el('dt', { text: label }),
      el('dd', {}, [
        el('span', { class: 'mono', text: value }),
        version && el('span', { class: 'ver', text: ` ${version}` }),
      ]),
    ]),
    el('dt', { text: 'Source' }),
    el('dd', {}, [
      el('a', {
        class: 'mono',
        href: `${REPO}/tree/main/${found.path}`,
        text: found.path,
        rel: 'noreferrer',
      }),
    ]),
  ]);
}

function scores(found) {
  return el('div', { class: 'card' }, [
    el('h4', {}, [
      'Coverage',
      el('span', {
        class: 'kind',
        text: 'summed over every signal this run emitted',
      }),
    ]),
    el('dl', { class: 'facts' }, [
      el('dt', { text: 'Required' }),
      el('dd', {}, [coverageBar(scoreOf(found, 'required'), 'required')]),
      el('dt', { text: 'Recommended' }),
      el('dd', {}, [coverageBar(scoreOf(found, 'recommended'), 'recommended')]),
      el('dt', { text: 'Findings' }),
      el('dd', {}, [
        el('span', {
          text: found.summary.findings
            ? `${found.summary.findings} violations`
            : 'none',
        }),
      ]),
    ]),
  ]);
}

function signalCard(found, signal) {
  if (!signal.coverage) {
    return el('div', { class: 'card' }, [
      el('h4', {}, [
        el('span', { class: 'mono', text: signal.name }),
        el('span', { class: 'kind', text: `${signal.type} · not in the registry` }),
      ]),
      el('p', {
        class: 'lede',
        text:
          'This report was built against a registry that no longer declares ' +
          'the signal the run was measured under, which only happens when a ' +
          'pin moved after the run. There is no denominator, so its ' +
          'attributes are listed as emitted and left uncounted.',
      }),
      attributeList(signal.emitted, 'emitted'),
    ]);
  }

  const present = LEVELS.filter((level) => signal.coverage[level]);
  return el('div', { class: 'card' }, [
    el('h4', {}, [
      el('span', { class: 'mono', text: signal.name }),
      el('span', {
        class: 'kind',
        text: `${signal.type}${signal.identity?.span_kind ? ` · ${signal.identity.span_kind}` : ''}`,
      }),
      el('a', {
        href: `#/signals/${encodeURIComponent(signal.name)}`,
        text: 'compare across targets →',
        style: 'margin-left:auto;font-size:.8rem;font-weight:400',
      }),
    ]),
    levelBar(signal.coverage),
    el(
      'p',
      { class: 'legend' },
      present.map((level) => {
        const tally = signal.coverage[level];
        return el('span', {
          text: `${LEVEL_LABEL[level] ?? level} ${tally.emitted}/${tally.declared}`,
          title: LEVEL_NOTE[level],
        });
      }),
    ),
    el('p', { class: 'subhead', text: `Emitted (${signal.emitted.length})` }),
    attributeList(signal.emitted, 'emitted'),
    signal.missing.length > 0 &&
      el('details', {}, [
        el('summary', {
          text: `Declared but not emitted (${signal.missing.length})`,
        }),
        attributeList(signal.missing, 'missing'),
      ]),
  ]);
}

function attributeList(names, kind) {
  if (!names.length) return el('p', { class: 'ver', text: 'none' });
  return el(
    'p',
    { class: `attrs ${kind}` },
    names.map((name) => el('code', { text: name })),
  );
}

/**
 * The resource entities the run carried, named rather than counted.
 *
 * A count of the identifying attributes says nothing: the reduction only
 * records an entity when *every* declared identifying attribute was emitted
 * (see `_entities` in the runner's `_semconv`), so that number is a constant
 * per entity name. What varies is the descriptive attributes, and their
 * denominator is the registry's declaration — already in the report, and read
 * by nothing until now.
 */
function entities(data, found) {
  const names = Object.keys(found.entities ?? {});
  if (!names.length) return null;
  const declared = data.report.registry?.[found.runner]?.entities ?? {};

  return el('div', { class: 'card' }, [
    el('h4', {}, [
      'Resource entities',
      el('span', {
        class: 'kind',
        text: 'recognised only when every identifying attribute was present',
      }),
    ]),
    ...names.sort().map((name) => {
      const entity = found.entities[name];
      const description = Object.keys(declared[name]?.description ?? {});
      const carried = new Set(entity.description);
      const absent = description.filter((attribute) => !carried.has(attribute));

      return el('dl', { class: 'entity' }, [
        el('dt', {}, [el('span', { class: 'mono', text: name })]),
        el('dd', {}, [
          el('span', { class: 'entity-role', text: 'identified by' }),
          attributeList(entity.identity, 'emitted'),
        ]),
        // No declared descriptive attributes at all — `service.instance` is
        // one — which is not the same as having carried none of them.
        // No declared descriptive attributes is not the same as having
        // emitted none of them, and an empty `emitted` line beside a full
        // `not emitted` one says nothing twice.
        description.length === 0 &&
          el('dd', {}, [
            el('span', { class: 'ver', text: 'nothing further declared' }),
          ]),
        entity.description.length > 0 &&
          el('dd', {}, [
            el('span', { class: 'entity-role', text: 'emitted' }),
            attributeList(entity.description, 'emitted'),
          ]),
        absent.length > 0 &&
          el('dd', {}, [
            el('span', { class: 'entity-role', text: 'not emitted' }),
            attributeList(absent, 'missing'),
          ]),
      ]);
    }),
  ]);
}

function findings(found) {
  if (!found.findings.length) {
    return el('div', { class: 'card' }, [
      el('h4', { text: 'Findings' }),
      el('p', { class: 'ver', text: 'None. Weaver recorded no violations on this run.' }),
    ]);
  }
  const grouped = new Map();
  for (const finding of found.findings) {
    if (!grouped.has(finding.id)) grouped.set(finding.id, []);
    grouped.get(finding.id).push(finding);
  }
  const absent = found.findings.filter((f) => isAbsence(f.id)).length;
  return el('div', { class: 'card' }, [
    el('h4', {}, [
      'Findings',
      el('span', { class: 'kind', text: `${found.findings.length} across ${grouped.size} kinds` }),
    ]),
    absent > 0 &&
      el('p', {
        class: 'lede',
        text:
          `${absent} of these restate a coverage gap above — weaver records ` +
          'an attribute the registry declares and the run did not carry as a ' +
          'violation.' +
          (found.findings.length > absent
            ? ` The other ${found.findings.length - absent} are about what ` +
              'did arrive.'
            : ''),
      }),
    ...[...grouped.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([id, items]) =>
        el('details', { open: items.length <= 3 }, [
          el('summary', {}, [
            el('a', {
              class: 'finding-id',
              href: `#/findings/${encodeURIComponent(id)}`,
              text: id,
            }),
            el('span', { class: 'ver', text: ` × ${items.length}` }),
          ]),
          ...items.map((finding) =>
            el('div', { class: 'finding' }, [
              el('span', { class: 'msg', text: finding.message }),
              finding.signal_name &&
                el('span', {
                  class: 'where',
                  text: `on ${finding.signal_type} ${finding.signal_name}`,
                }),
            ]),
          ),
        ]),
      ),
  ]);
}
