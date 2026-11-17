## Summary
What does this PR change?

## Type
- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Docs
- [ ] Test
- [ ] CI

## Changes
-

## Validation
How did you test this?

## Checklist
- [ ] Ran the checks in [Before you open a PR](https://github.com/ix-infrastructure/Ix/blob/main/CONTRIBUTING.md#before-you-open-a-pr)
- [ ] No raw errors introduced
- [ ] CLI output follows Ix format

## Release notes
Do not bump `ix-cli/package.json`: a maintainer releases by pushing a `vX.Y.Z` tag, and the release workflow stamps the version from the tag.
- [ ] If this needs a backend change: the `ix-memory-layer` release that serves it is out (maintainers only, see [Backend Development](https://github.com/ix-infrastructure/Ix/blob/main/CONTRIBUTING.md#backend-development))
- [ ] If `docker-compose.standalone.yml` changed: verified `curl | sh` install works
