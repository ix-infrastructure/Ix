# Track A Linux portability prerequisite

**Deferred.** Step 5 did not run a timing workload. Production rollout retains its +5% no-evidence median gate.

The Step 4.1 archive was produced on arm64 macOS with Node 26.12.0. It supplies the compiled Step 3 and Step 4 JavaScript distributions and their package manifests. It omits installed dependencies and lockfiles. A copy of the macOS dependency trees or their absolute symlinks will not provide a valid Linux runtime. In particular, core-ingestion loads native tree-sitter and grammar bindings. A missing grammar may degrade parsing and invalidate the fixture even if the CLI starts.

Before the approved dedicated-host run:

1. Use a native Linux host and Node 26.12.0 for its architecture. Record CPU architecture, libc, Node ABI, Node/npm versions and effective locale. Obtain the exact Ix checkout/lockfiles that accompanied the frozen builds. Verify the archived package manifests against the locked dependencies. Keep the archived dist files intact.
2. Run npm ci separately in ix-cli and core-ingestion in the dependency checkout on Linux, with the native compiler toolchain if needed. Link each archived package's node_modules to the corresponding Linux installation. Both snapshots must resolve the same real dependency directories. Never reuse Darwin .node files, globally installed ix, or macOS Homebrew paths.
3. Confirm both archived CLIs start via the pinned Linux Node binary. Through each archived parser, parse a tiny TS function and assert its named symbol exists. Through the candidate, check a known positive state assignment is actually extracted as well as the plain negative. Verify distribution hashes against completed/manifest.json, the compose image digest/platform, lockfile hashes and the TypeScript grammar. Resolve any layout, ABI, import or grammar mismatch before timing. Use systemd-inhibit and taskset on Linux under the approved resource reservations.
4. Treat a failed preflight as infrastructure-blocked. Rebuilding a changed distribution would require a newly identified comparison pair. Record the build identity and repeat preflight before any performance claim.

Local reference checkout at evaluation time: 83cd3e684f2df7a82508958a5b936013fafdcc8c, with the existing Step 4 working tree.
