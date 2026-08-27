// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// The shell: load the report once, then render whichever view the hash names.
//
// Hash routing rather than paths, because the site is served from Pages with
// no rewrite rules — a deep link has to survive a cold load, and `#/target/x`
// does while `/target/x` would 404.

import { load } from './data.js';
import { el } from './ui.js';

import signals from './views/signals.js';

// Two entries for the one view: `#/` is the site's front door and
// `#/signals/<name>` is what the signal selector writes. They stay separate so
// the front door can be repointed at a landing view without touching the
// deep link.
const ROUTES = [
  { name: 'signals', match: /^\/?$/, view: signals },
  { name: 'signals', match: /^\/signals(?:\/(.+))?$/, view: signals },
];

const main = document.querySelector('main');

function resolve(hash) {
  const path = decodeURIComponent(hash.replace(/^#/, '')) || '/';
  for (const route of ROUTES) {
    const found = path.match(route.match);
    if (found) return { route, argument: found[1] ?? null };
  }
  return { route: ROUTES[0], argument: null };
}

function render(data) {
  const { route, argument } = resolve(location.hash);
  try {
    main.replaceChildren(route.view(data, argument));
  } catch (error) {
    console.error(error);
    main.replaceChildren(
      el('p', { class: 'empty', text: `Could not render this view: ${error.message}` }),
    );
  }
  document.title = `${route.name} · conformance`;
}

function provenance(data) {
  const pins = Object.entries(data.report.domains).map(
    ([name, pin]) =>
      `${name} → ${pin.registry_repo} @ ${pin.registry_ref.slice(0, 12)}`,
  );
  document.querySelector('#provenance').textContent =
    `${data.targets.length} targets. Registries: ${pins.join('; ')}.`;
}

load()
  .then((data) => {
    provenance(data);
    render(data);
    addEventListener('hashchange', () => {
      render(data);
      scrollTo({ top: 0 });
    });
  })
  .catch((error) => {
    console.error(error);
    main.replaceChildren(
      el('div', { class: 'note' }, [
        el('p', { html: '<strong>The report could not be loaded.</strong>' }),
        el('p', {
          text:
            'The page reads data/conformance.json over fetch, which a browser ' +
            'refuses to do from a file:// URL — the usual cause. Serve the ' +
            'directory instead: python -m http.server -d docs',
        }),
        el('p', { class: 'ver', text: String(error) }),
      ]),
    );
  });
