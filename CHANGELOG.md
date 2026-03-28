# Changelog

## [0.5.0](https://github.com/ix-infrastructure/Ix/compare/v0.4.0...v0.5.0) (2026-03-28)


### Features

* add backend-backed symbol graph projection for visualizer ([ebf6830](https://github.com/ix-infrastructure/Ix/commit/ebf68306f52d969469e7825b98af14c9adec5610))
* add Windows bash installer support ([34a9a95](https://github.com/ix-infrastructure/Ix/commit/34a9a95cc0350c2efc6de28bbedc90ac99aa2c57))
* add Windows bash installer support ([#54](https://github.com/ix-infrastructure/Ix/issues/54)) ([4396648](https://github.com/ix-infrastructure/Ix/commit/43966484140dbb19da68e21f10b7f726eb038a18))
* **cli:** add `ix view` command with bundled System Compass visualizer ([51ac48a](https://github.com/ix-infrastructure/Ix/commit/51ac48abbeb4813d00c5a0d74023d0ed01e8aa15))
* large repo ingest perf, map improvements, and Claude plugin v2 ([4d4dfa6](https://github.com/ix-infrastructure/Ix/commit/4d4dfa6d58db474ce2753e6fbed025fd07aeaca6))
* multi-lang parse, Rust tokio fixes, and ingest progress bar ([f09ff60](https://github.com/ix-infrastructure/Ix/commit/f09ff608758d9f130c7c8ec437f5f8095d9ec057))
* multi-language parsing and CLI improvements ([b2d9e2d](https://github.com/ix-infrastructure/Ix/commit/b2d9e2dd85229750380d29109c52516286738431))
* refine TypeScript parser, improve ingest performance, and adjust map output ([7258e0d](https://github.com/ix-infrastructure/Ix/commit/7258e0d9cd2c2baf81bb9ff2fa7387be972cbf70))
* restore parsing speed improvements ([3e3fb8c](https://github.com/ix-infrastructure/Ix/commit/3e3fb8cecf727699f69fafbebb97e27310a26465))
* restore parsing speed improvements from patch branch ([08d883c](https://github.com/ix-infrastructure/Ix/commit/08d883c9ff2d3cdf0b94f976e607d22c41ca05d2))
* speed up of ix map increasing speed for larger repos and allowed mapping for larger repos ([e7a95ea](https://github.com/ix-infrastructure/Ix/commit/e7a95ea1202f48ee41b70e3d4b04baa614483186))


### Bug Fixes

* add 5-minute timeout to commitPatchBulk and commitPatch ([8454640](https://github.com/ix-infrastructure/Ix/commit/8454640adfbd18361336d97b4d058781820b0477))
* add missing edges param to ArchitectureMap in test ([e669af1](https://github.com/ix-infrastructure/Ix/commit/e669af186b4d41fb4a0a8a56ec6b1eaa3b336324))
* build multi-platform Docker image (amd64 + arm64) ([a176d59](https://github.com/ix-infrastructure/Ix/commit/a176d590e8ab4101f2e1a753146779607c1923af))
* correct version display and add upgrade to help text ([#47](https://github.com/ix-infrastructure/Ix/issues/47)) ([61399a5](https://github.com/ix-infrastructure/Ix/commit/61399a53c33f95725b7bb525597b1560538d2548))
* **docker:** remove internal:true and add --pull always ([a44ed3c](https://github.com/ix-infrastructure/Ix/commit/a44ed3c5ba0a03c204001de2be214fe811493e3b))
* **docker:** remove internal:true from backend network ([3bfa171](https://github.com/ix-infrastructure/Ix/commit/3bfa17166a1fc5e6dc4402aa339f457cd573e1b1))
* **docker:** resolve merge conflicts and add --pull always to compose up ([88d49a6](https://github.com/ix-infrastructure/Ix/commit/88d49a6b0ed799bd3fa9de454bb54018438188be))
* ensure compose file exists on start even when backend is already healthy ([907ccd5](https://github.com/ix-infrastructure/Ix/commit/907ccd534a3ecfb02ce0cf8eafce7adfd4589508))
* ensure compose file exists on start even when backend is already healthy ([1116272](https://github.com/ix-infrastructure/Ix/commit/1116272a7ea67c09f92aa98f1050425c3b08c7d4))
* include core-ingestion in release tarballs and fix ESM __dirname in upgrade ([8dc343e](https://github.com/ix-infrastructure/Ix/commit/8dc343e918c79f7dbb4172cf95c52f42d1fbf2c5))
* include core-ingestion in release tarballs and fix ESM __dirname in upgrade ([eaa4747](https://github.com/ix-infrastructure/Ix/commit/eaa47476be7f13eb2977c01c707ad68404a66249))
* include core-ingestion node_modules in release tarballs ([a8f33fd](https://github.com/ix-infrastructure/Ix/commit/a8f33fdd17bf001c6f915c2f5fd2151e51c01782))
* include core-ingestion node_modules in release tarballs ([90d5874](https://github.com/ix-infrastructure/Ix/commit/90d587445db43359c426b11c619c8e4b3f930f8c))
* **ingest:** gate logSaveTiming behind debug and truncate commit errors ([8e23161](https://github.com/ix-infrastructure/Ix/commit/8e231612ab3bed3b26139c3d2f9c2c50d7535a52))
* **install:** auto-start backend and fix stale repo refs ([#73](https://github.com/ix-infrastructure/Ix/issues/73)) ([c8aa29b](https://github.com/ix-infrastructure/Ix/commit/c8aa29b03890c9270949467f70b26daf1c5465f4))
* **install:** fix version parsing from GitHub API ([9b03b64](https://github.com/ix-infrastructure/Ix/commit/9b03b641e8bd234e8d588f6d300cce83581ec540))
* **install:** fix version parsing from GitHub API single-line JSON ([1ff10e2](https://github.com/ix-infrastructure/Ix/commit/1ff10e265221b33cc13ff2749af0217c5e709fb4))
* **install:** update stale IX-Memory repo refs and remove deprecated ix init ([#71](https://github.com/ix-infrastructure/Ix/issues/71)) ([767f076](https://github.com/ix-infrastructure/Ix/commit/767f076d4abd0513c8878c48aae337cb24492740))
* make Homebrew formula step non-blocking in release workflow ([4708176](https://github.com/ix-infrastructure/Ix/commit/470817696df573685b94a20a419f94cc8b29b802))
* **release:** make compass build optional ([5a44d94](https://github.com/ix-infrastructure/Ix/commit/5a44d947e9f7dc0548612b2e72a549d2b6b2b197))
* **release:** make System Compass build optional ([af3e3af](https://github.com/ix-infrastructure/Ix/commit/af3e3af9d7fdb6669868cd27e25a12ddf69469b7))
* **release:** pass COMPASS_TOKEN via env var to avoid interpolation issues ([8c27ca0](https://github.com/ix-infrastructure/Ix/commit/8c27ca0e4505c947e79ccacc2b155ab1c3f08c0f))
* remove stale edges param from MapServiceScopeSpec ([c1067db](https://github.com/ix-infrastructure/Ix/commit/c1067dbabe1114766e4bc870dd89dd3010eb9191))
* restore architecture edges dropped during large-repo-map-perf merge ([9148e80](https://github.com/ix-infrastructure/Ix/commit/9148e80706fa0e0b3de13adec70039cede610cad))
* restore architecture edges for visualizer ([fe4c435](https://github.com/ix-infrastructure/Ix/commit/fe4c4350f54bc36b82d5185ade3674271ebbc1dc))
* restore cats traverse in ArangoClient.query and untrack stale dist/ ([d5e6557](https://github.com/ix-infrastructure/Ix/commit/d5e6557f9b69c1b1487d1602eeab84a9de38b229))
* Ruby scoped class name definitions and heritage patterns ([7935037](https://github.com/ix-infrastructure/Ix/commit/7935037cc58fd8f3fe70f8b670890191a717b97e))
* **scripts:** fix IX_DIR resolution and add Windows cmd shim support ([4af5b55](https://github.com/ix-infrastructure/Ix/commit/4af5b55a51e97e2c57c5b9e3f1bbb8e811ad1868))
* security audit — shell injection, temp files, license, Dockerfile ([#49](https://github.com/ix-infrastructure/Ix/issues/49)) ([f962487](https://github.com/ix-infrastructure/Ix/commit/f9624870783805c33185b7766a7bb6af2b56fdb6))
* **server:** add Macro to NodeKind ([89160a4](https://github.com/ix-infrastructure/Ix/commit/89160a4f9e72ab5ca0caf303b2e16170b20550b2))
* stream large repos instead of parse-all-first, reduce concurrency to 4 ([466596e](https://github.com/ix-infrastructure/Ix/commit/466596ea15a9a21aef97cd4b6c06ce88be9f791b))
* suppress verbose Docker pull output during install ([eff31c6](https://github.com/ix-infrastructure/Ix/commit/eff31c66bf443cea4e10d140cc9f510c68aabf9c))
* **test:** update file-resolution test to match tryFileGraphMatch signature ([4997641](https://github.com/ix-infrastructure/Ix/commit/4997641458b4a1a7dd15c70d4a83f92a83e859b4))
* update help-coverage test for new branding and command list ([7dff1e4](https://github.com/ix-infrastructure/Ix/commit/7dff1e4500e61bad116b9ddfc82a21d1e1172d5d))
* update shim on Linux/Mac after ix upgrade ([97df620](https://github.com/ix-infrastructure/Ix/commit/97df62016139c155def4d0c2d5b3ea74ef41e772))


### Performance Improvements

* **db:** ArangoDB write path optimizations — 130s → 82s Kubernetes ([30d2cf2](https://github.com/ix-infrastructure/Ix/commit/30d2cf21c461b6030cd50e195c666ece65e56ab9))
* **db:** parallel chunk processing and compute-pool doc building ([67168f0](https://github.com/ix-infrastructure/Ix/commit/67168f0eded22bd119b43cbb15e45465ea77f5a6))
* **db:** parallelize bulk insert batches, raise connection pool, drop waitForSync ([928f5c3](https://github.com/ix-infrastructure/Ix/commit/928f5c321747903195c9cf501eb4d4e72ce4e478))
* **ingest:** map-mode optimization + ix view command ([f5bf12c](https://github.com/ix-infrastructure/Ix/commit/f5bf12c181327541851eeceb1d7c260e6873f861))
* **ingest:** overlap file I/O with parse dispatch; raise COMMIT_CONCURRENCY to 8 ([560001e](https://github.com/ix-infrastructure/Ix/commit/560001e996e7ff65c1f84de5999c2a00efed0226))
* **ingest:** strip chunks/claims in map mode and increase bulk write limits ([dd2c0a8](https://github.com/ix-infrastructure/Ix/commit/dd2c0a8c7fda940566ff6d29d068e9b2358004f0))
* large repo map + ingest performance ([#60](https://github.com/ix-infrastructure/Ix/issues/60)) ([befde2c](https://github.com/ix-infrastructure/Ix/commit/befde2c38786251239dd93a6adbdadcfe5e5877b))
* reduce network round-trips and DB write overhead ([7a6d9f5](https://github.com/ix-infrastructure/Ix/commit/7a6d9f541b606ecb7ea5a347f9f5c2f5fa1b873f))


### Reverts

* remove memory-layer changes, keeping branch parsing-only ([b602308](https://github.com/ix-infrastructure/Ix/commit/b60230812a184b1bdf54ea1ca7175da4e1963e0d))
