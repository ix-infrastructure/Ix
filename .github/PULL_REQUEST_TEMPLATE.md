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
- [ ] Tests pass
- [ ] Smoke tests pass
- [ ] No raw errors introduced
- [ ] CLI output follows Ix format

## Release checklist (maintainers, when cutting a release)
- [ ] After merge: tag pushed (`git tag vX.Y.Z && git push origin vX.Y.Z`); the release workflow stamps the version from the tag, so `ix-cli/package.json` is not bumped by hand
- [ ] If backend changes: `ix-memory-layer` tagged and released first (maintainers only — see [Backend Development](https://github.com/ix-infrastructure/Ix/blob/main/CONTRIBUTING.md#backend-development))
- [ ] If `docker-compose.standalone.yml` changed: verified `curl | sh` install works
