# The site

A static page over the committed report. No build step, no bundler, no
dependencies: `index.html` loads ES modules straight from `assets/`, and the
whole of the data layer is one `fetch` of `data/conformance.json`.

That is deliberate. The report is the artifact — deterministic, gated
byte-for-byte in CI, and content-addressed by the ecosystem registry
downstream. A toolchain between it and the page would be one more thing that
could disagree with it.

| | |
| --- | --- |
| `index.html` | the shell: masthead, nav, and the one `<script type="module">` |
| `assets/app.js` | the hash router, and the provenance line in the footer |
| `assets/data.js` | fetch, and the index every view reads from |
| `assets/ui.js` | the element helpers |
| `assets/views/` | one module per route |
| `data/conformance.json` | committed, written by `otel-conformance-report build` |

## Locally

The page reads its data over `fetch`, which a browser refuses to do from a
`file://` URL. Serve the directory:

```sh
python -m http.server -d docs
```

That is the whole of it — the committed `conformance.json` is already in the
checkout, so nothing needs building first. See
[the report tool's README](../tools/report/README.md) for how that file is
produced.

## Publishing

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml), on every push
to `main`. It uploads `docs/` whole and deploys.

It publishes the *committed* `conformance.json` rather than a fresh build, so
what the site shows is the file a pull request gated — the same bytes, not a
rebuild that happens to agree. The `check` in that workflow only refuses to
publish a stale one, for a commit that reached `main` without CI having run.

One repository setting is not in the workflow: **Settings → Pages → Build and
deployment → Source** must be *GitHub Actions*. A deploy against the default
(*Deploy from a branch*) fails at the last step.
