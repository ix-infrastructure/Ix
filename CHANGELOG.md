# Changelog

## [0.5.1](https://github.com/ix-infrastructure/Ix/compare/v0.5.0...v0.5.1) (2026-03-28)


### Bug Fixes

* **release:** add workflow_dispatch trigger for manual releases ([397cf8c](https://github.com/ix-infrastructure/Ix/commit/397cf8c5da1c06a565d5ed62d442ad1983834a2e))
* **release:** bundle compass and core-ingestion in release-please tarballs ([#76](https://github.com/ix-infrastructure/Ix/issues/76)) ([f622c19](https://github.com/ix-infrastructure/Ix/commit/f622c19dc63bdf2a72e70c69e73ca7666466f301))
* **release:** move COMPASS_TOKEN check into shell (secrets not allowed in step if) ([ff5c09a](https://github.com/ix-infrastructure/Ix/commit/ff5c09ae8cf082cbd54e078fc387036cf335e920))
* **release:** set explicit tag_name for workflow_dispatch compatibility ([6718368](https://github.com/ix-infrastructure/Ix/commit/6718368729e14559c2e922ff8042b5e32e988fbc))
* **release:** use --legacy-peer-deps for compass build ([#82](https://github.com/ix-infrastructure/Ix/issues/82)) ([1d4bc22](https://github.com/ix-infrastructure/Ix/commit/1d4bc22fbaf7e8fa2e88658c5198de2fd2a3cdd0))


### Performance Improvements

* **cli:** optimize JSON output across all commands ([#79](https://github.com/ix-infrastructure/Ix/issues/79)) ([5065efc](https://github.com/ix-infrastructure/Ix/commit/5065efc5626c29ead2ad21d3248b89dfdb2f4e5c))
* **memory-layer:** unify smell detection into single AQL query and parallelize IO ([63f4d53](https://github.com/ix-infrastructure/Ix/commit/63f4d537970cad24d499b837105e7da83bc7b6c4))
* **smell:** use index-backed per-file subqueries instead of MERGE maps ([#77](https://github.com/ix-infrastructure/Ix/issues/77)) ([01d2c18](https://github.com/ix-infrastructure/Ix/commit/01d2c185c565f10f703ae587051950e625943102))
