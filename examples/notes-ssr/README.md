# notes-ssr

A minimal notes service whose page is served by the service itself.

```bash
arcod build examples/notes-ssr --impl
arcod run examples/notes-ssr
```

Open the service route (`/`): `ui { render: ssr }` embeds the page in the
service, and the first screen comes from `Notes.list` — the first public `GET`
operation without a path parameter. The service calls it in-process at request
time, so the notes are already in the HTML (in the `"data"` slot of `SSR`) and
the browser hydrates that slot instead of issuing a second request. `POST`
still works from the generated form, so a note created after load shows up on
the next page load.

Compose for an `ssr` build has no nginx sidecar: the service is the front door.
