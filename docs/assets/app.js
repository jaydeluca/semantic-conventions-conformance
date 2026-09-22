// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Hash routes support direct links on GitHub Pages without server rewrites.
// Which report is loaded is a separate axis from the route, so it lives in
// the real query string (`?v=`) rather than the hash: switching versions
// should survive navigating between signals, and `go()` deliberately drops
// the hash's own query when it changes route.

import { load, loadVersions } from "./data.js";
import { current } from "./route.js";
import { el } from "./ui.js";

import * as signals from "./views/signals.js";

const ROUTES = [
  { name: "signals", match: /^\/?$/, view: signals },
  { name: "signals", match: /^\/signals(?:\/(.+))?$/, view: signals },
];

const main = document.querySelector("main");
const versionBar = document.querySelector("#version-bar");

document.querySelector(".skip").addEventListener("click", (event) => {
  event.preventDefault();
  main.focus();
});

function resolve() {
  const { path, params } = current();
  for (const route of ROUTES) {
    const found = path.match(route.match);
    if (found) return { route, argument: found[1] ?? null, params };
  }
  return { route: ROUTES[0], argument: null, params };
}

function render(data) {
  const { route, argument, params } = resolve();
  let title = `${route.name} · conformance`;
  try {
    main.replaceChildren(route.view.default(data, argument, params));
    title = route.view.title?.(data, argument) ?? title;
  } catch (error) {
    console.error(error);
    main.replaceChildren(
      el("p", {
        class: "empty",
        text: `Could not render this view: ${error.message}`,
      }),
    );
  }
  document.title = title;
}

function provenance(data) {
  const pins = Object.entries(data.report.domains).map(
    ([name, pin]) =>
      `${name} → ${pin.registry_repo} @ ${pin.registry_ref.slice(0, 12)}`,
  );
  document.querySelector("#provenance").textContent =
    `${data.targets.length} targets. Registries: ${pins.join("; ")}.`;
}

/** @param {VersionEntry[]} versions @returns {string} */
function currentVersionId(versions) {
  const requested = new URLSearchParams(location.search).get("v");
  return (
    versions.find((version) => version.id === requested)?.id ?? versions[0].id
  );
}

/** @param {string} id @param {string} defaultId */
function rememberVersion(id, defaultId) {
  const params = new URLSearchParams(location.search);
  if (id === defaultId) params.delete("v");
  else params.set("v", id);
  const query = params.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
  );
}

/**
 * @param {VersionEntry[]} versions
 * @param {string} selected the current version's `id`
 * @param {(id: string) => void} onChange
 */
function renderVersionBar(versions, selected, onChange) {
  // One report is the common case, and a picker with nothing to pick is a
  // control that does nothing, so it stays hidden until there is a choice.
  if (versions.length < 2) {
    versionBar.hidden = true;
    return;
  }
  const select = el(
    "select",
    {
      "aria-label": "Agent version",
      onchange: (e) => onChange(e.target.value),
    },
    versions.map((version) =>
      el("option", { value: version.id, text: version.label }),
    ),
  );
  select.value = selected;
  versionBar.hidden = false;
  versionBar.replaceChildren(
    el("label", { class: "version-picker" }, [
      el("span", { text: "Agent version" }),
      select,
    ]),
  );
}

/** @typedef {import('./data.js').VersionEntry} VersionEntry */

async function boot() {
  let versions = await loadVersions().catch(() => null);
  if (!Array.isArray(versions) || !versions.length) {
    versions = [
      { id: "default", label: "Report", file: "data/conformance.json" },
    ];
  }

  let selected = currentVersionId(versions);
  let data = await load(versions.find((v) => v.id === selected).file);

  renderVersionBar(versions, selected, async (id) => {
    selected = id;
    rememberVersion(selected, versions[0].id);
    data = await load(versions.find((v) => v.id === selected).file);
    provenance(data);
    render(data);
  });
  provenance(data);
  render(data);

  let path = current().raw;
  addEventListener("hashchange", () => {
    // Filters write themselves into the query, which fires no hashchange;
    // guarding on the path anyway keeps a stray one from wiping the view.
    if (current().raw === path) return;
    path = current().raw;
    render(data);
    scrollTo({ top: 0 });
  });
}

boot().catch((error) => {
  console.error(error);
  main.replaceChildren(
    el("div", { class: "note" }, [
      el("p", {}, [el("strong", { text: "The report could not be loaded." })]),
      location.protocol === "file:" &&
        el("p", {
          text:
            "The page reads data/conformance.json over fetch, which a browser " +
            "refuses to do from a file:// URL. Serve the directory instead: " +
            "python -m http.server -d docs",
        }),
      el("p", { class: "ver", text: String(error) }),
    ]),
  );
});
