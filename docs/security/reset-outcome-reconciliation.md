# Reset outcome reconciliation

An asynchronous reset can change graph or ingestion state before the client
loses its connection or status entry. Repeating it can delete work created
since the original reset. A missing status does not establish that nothing ran.

The CLI now requires a 202 start acknowledgment with a UUID and a status body
identifying that same operation with `running`, `done` or `failed`. It stops
with explicit reconciliation guidance after missing, denied, invalid or
unavailable status, a partial failure, or an observation deadline. It reports
the operation ID when known and never submits another reset on these paths.

An administrator should inspect the original operation, graph effects and
pipeline claim before deciding how to recover. Do not delete a durable claim
or create a new reset solely because a status is absent. The status ledger is
process-local and bounded: restarts, replica selection and eviction can each
make an operation unavailable while the reset itself completed.

The status route resolves an operation ID against that ledger alone and does
not itself scope the lookup to a tenant; any authorization is whatever the
transport in front of it enforces. Reset scoping is also still being
corrected — a pooled full reset could truncate the bootstrap database despite
resolving a different tenant (Ix-memory#207, backported for production in
#208). Until those land, treat the blast radius of a repeated reset as wider
than the tenant that issued it, which is the main reason this client stops
rather than retrying.

Local synchronous reset and the existing synchronous fallback for an absent
async **start** route remain. A 404 from **status** never invokes that fallback.
Authentication errors at start remain errors. This patch does not add tenant
headers, credentials or an authorization bypass; the remote transport must
establish the expected verified caller identity.

`ix-cli/src/client/reset-outcome.test.ts` executes the real client with synthetic
HTTP responses and asserts the exact request sequence. It covers success for
both reset kinds, invalid/foreign operation IDs, partial failure, transport
loss, deadlines and local/older-server compatibility. Live authenticated
remote transport and supported-release integration still need verification
before claiming deployment acceptance.

Pro is an optional, separately installed private plugin; the OSS package does
not fetch it as a dependency. Its explicit runtime resolution is therefore
listed in Knip's dependency exceptions. The loader returns normally only when
Pro is absent or fully initialized. Missing peer modules, invalid registration
exports, and credential-guard failures in an installed Pro abort command
startup instead of silently falling back to unguarded OSS execution.
