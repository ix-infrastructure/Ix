
# Real-backend harness

These scenarios drive the built CLI against a real memory-layer and ArangoDB and
check one property: **after any sequence of edits and `ix map` runs, the graph
equals a fresh ingest of the same tree.** They compare graph signatures read
straight from ArangoDB, so they catch a graph that is wrong but looks healthy.

The unit suite (`npm test`) never runs them: scenario files end in `.e2e.ts`,
which the default vitest config does not collect.

## Run it

```sh
cd ix-cli
npm run e2e:up                  # throwaway stack on 8290 / 8729
IX_E2E=1 npm run test:e2e       # builds dist/, then runs the scenarios (~40 s)
npm run e2e:down                # removes the containers and the volume
```

`test:e2e` runs `npm run build` first, because the scenarios execute
`dist/cli/main.js`. To skip the build, run
`IX_E2E=1 npx vitest run --config vitest.e2e.config.ts`.

Every scenario starts with `POST /v1/reset`, which empties the whole database.
The harness therefore refuses to run unless `IX_E2E=1` is set, and refuses any
endpoint that is not loopback or that uses a port of a stack with real data:
8090, 8091, 8099, 8100, 8190 (backends) and 8529, 8530, 8539, 8540, 8629
(ArangoDB).

## Configuration

| Variable | Default | Used by |
|---|---|---|
| `IX_E2E` | unset | must be `1` to run |
| `IX_E2E_PROJECT` | `ix-e2e` | compose project name |
| `IX_E2E_BACKEND_PORT` | `8290` | compose and harness: host port of the memory-layer |
| `IX_E2E_ARANGO_PORT` | `8729` | compose and harness: host port of ArangoDB |
| `IX_E2E_BACKEND_IMAGE` | `ghcr.io/ix-infrastructure/ix-memory-layer:1.0.31@sha256:7f972fb0…` | compose: the backend under test |
| `IX_E2E_ENDPOINT` | `http://127.0.0.1:$IX_E2E_BACKEND_PORT` | harness: backend URL, overrides the port |
| `IX_E2E_ARANGO_URL` | `http://127.0.0.1:$IX_E2E_ARANGO_PORT` | harness and `graph-sig.mjs`: ArangoDB URL |
| `IX_E2E_DIFF_DIR` | unset | harness: write every graph difference to `<dir>/<scenario>.txt` |
| `IX_TOKEN` | unset | harness: sent as `Authorization: Bearer` on the reset call |

Set the same `IX_E2E_*` values for `e2e:up`, `test:e2e` and `e2e:down`.

### Several stacks at once

Each stack needs its own project name and ports. One stack is capped at about
2.7 GB (ArangoDB 1200 MB, backend 1500 MB), so keep at most two up on a laptop
and always finish with `e2e:down`.

| Who | `IX_E2E_PROJECT` | `IX_E2E_BACKEND_PORT` | `IX_E2E_ARANGO_PORT` |
|---|---|---|---|
| default, CI | `ix-e2e` | 8290 | 8729 |
| second stack | `ix-e2e-2` | 8291 | 8730 |
| third stack | `ix-e2e-3` | 8292 | 8731 |

```sh
export IX_E2E_PROJECT=ix-e2e-3 IX_E2E_BACKEND_PORT=8292 IX_E2E_ARANGO_PORT=8731
npm run e2e:up && IX_E2E=1 npm run test:e2e; npm run e2e:down
```

### Testing a backend change

Build an image from an Ix-memory checkout and point the stack at it:

```sh
cd <ix-memory checkout>
sbt assembly                                   # target/scala-2.13/ix-memory-layer.jar
docker build -f Dockerfile.core -t ix-memory-layer:my-fix .
cd <ix checkout>/ix-cli
IX_E2E_BACKEND_IMAGE=ix-memory-layer:my-fix npm run e2e:up
IX_E2E=1 npm run test:e2e
npm run e2e:down
```

Do not run Ix-memory's own `sbt test` on the host network next to other
stacks: the specs truncate whichever ArangoDB answers on `localhost:8529`.

## Scenarios

`scenarios.e2e.ts`. Each one copies a fixture to a temp dir, commits it with
git and uses a temp `IX_HOME`.

| Scenario | Compared with |
|---|---|
| A → B → A | the graph of A |
| rename a function and back | the original graph |
| delete a file and restore it | the original graph |
| branch round trip (rename, add, delete across files) | the graph of the starting branch |
| two workspaces sharing `README.md`, `package.json`, `.github/workflows/ci.yml` | the first workspace's graph before the second was mapped |
| edit one Python file; edit one TypeScript file; rename a file; add a file | a fresh map of the edited tree |
| map twice | the first map |

The fresh reference maps the same directory from a new, empty `IX_HOME`. The
directory has to stay the same: the workspace id, and with it the ids of
unresolved call targets, derive from the path.

### Known failures

A scenario that fails today until a fix lands is wrapped in `failsUntil([...])`
and titled `[fails until <task ids>]`. It passes while the graphs differ. It
turns red when they match, with a message asking for the marker to be removed,
so the PR that lands the last listed fix unwraps it. A fix that lands earlier
removes its own id from the title and the list. Any other error, such as a
crashed `ix map` or an unreachable database, fails the run either way.

To see what a marked scenario still gets wrong, set `IX_E2E_DIFF_DIR`.

## Fixtures

`fixtures/polyglot/` has 23 files: Python with cross-file calls (`app/`),
TypeScript with import-bound calls (`web/src/`), Java (`server/`), and
`README.md`, `package.json` and `.github/workflows/ci.yml`.
`fixtures/polyglot-b/` shares those last three names and nothing else. Other
tests may reuse them; keep them small.

## Graph signatures by hand

`graph-sig.mjs` is a Node port of the audit's `gsig.py` and `gdiff.py`:

```sh
export IX_E2E_ARANGO_URL=http://127.0.0.1:8729
node test/e2e/graph-sig.mjs sig <workspace_id> before.json
node test/e2e/graph-sig.mjs sig <workspace_id> after.json
node test/e2e/graph-sig.mjs diff before.json after.json 20   # exit 1 when they differ
```

A node prints as `kind|name|source_uri|line_start|line_end`, an edge as
`predicate|<src kind:name@uri>|<dst kind:name@uri>|source_uri`. An endpoint that
is not a live node of the workspace prints as `?<first 8 characters of its id>`.
Region nodes and `IN_REGION` edges are left out.
