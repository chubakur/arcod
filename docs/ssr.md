# Server-rendered pages — B12.6c

`ui { render: ssr }` makes the generated service the front door: it serves the
page at the ui route instead of an nginx sidecar (see `emit/compose.ts` and
`emit/k8s.ts`). This note records how the first screen gets its data.

## Which operation is the first screen

The first screen is the **first public `GET` operation without a path
parameter**, in contract order, among the operations the ui `uses`. A path
parameter or a body would require input the server does not have before the
browser says anything, so those operations are not eligible.

`ssrFirstScreenOp()` in `src/emit/web.ts` is the single rule; `src/check.ts`
imports the same idea to decide whether to warn (`W030`: an ssr page with no
first screen — the page still renders, just without data).

## How the data gets in

1. `emitWeb` writes the page with `var SSR = {"op":"<op>","data":__ARC_SSR_DATA__}`.
2. `build` passes `{ route, html, dataOp }` to `emitService`.
3. On `GET`/`HEAD`, the service calls the operation's handler **in-process**
   with a capturing response — no second HTTP round trip, no self-fetch.
4. The JSON replaces the marker, with `<` escaped so a value can never close
   the surrounding `<script>`.
5. The client script renders that slot (`data-ssr="hydrated"`) instead of
   issuing the call again.

Fail-open: if the handler throws or answers non-200, the page is served with
`"data":null` and the form still works — a broken store must not take the page
down.

## Guarantees

- The page response sets `cache-control: no-store` and
  `x-content-type-options: nosniff`: the first screen is per-request data.
- `HEAD` returns the same `content-length` as `GET` and no body.
- The static copy written to `web/index.html` has the marker replaced by
  `null`, because nothing would fill it there.
- Only the forms layout has a first screen; `layout: chat` and `layout:
  presentation` load their own state and are not warned about.

See `examples/notes-ssr` for a runnable model and `test/web-a11y.test.ts` for
the tests (marker presence, hydration, HEAD, failing store, static copy).
