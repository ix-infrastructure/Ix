---
name: ix-api-contract-change
description: Use when adding or changing memory-layer routes or ix-cli client methods so API contracts stay aligned across Scala routes, models, and TypeScript IxClient calls.
---

# Ix API Contract Change

Use this when touching:
- `memory-layer/src/main/scala/ix/memory/api/*Routes.scala`
- `memory-layer/src/main/scala/ix/memory/model/*`
- `ix-cli/src/client/api.ts`

## Workflow

1. Map blast radius:
```bash
ix impact IxClient --format json
ix search Routes --kind class --format json --limit 30
```

2. Inspect changed route surface:
```bash
ix overview <RouteClassName> --format json
ix read <absolute/path/to/RouteFile.scala:1-220> --format json
```

3. Align client boundary:
```bash
ix overview IxClient --format json
ix read <absolute/path/to/ix-cli/src/client/api.ts:1-260> --format json
```

4. Check for shared request/response model impact:
```bash
ix search <ModelName> --kind class --format json --limit 20
ix impact <ModelName> --format json
```

5. Validate expected tests were considered:
```bash
ix search RoutesSpec --kind class --format json --include-tests --limit 20
```

## Contract Checklist

- Route path and HTTP verb match client usage.
- Request fields, optionality, and defaults are consistent.
- Response shape and error behavior are consistent.
- New route is wired into aggregate route registration.

## Guardrails

- Treat `IxClient` as a high-risk boundary.
- If you changed a route signature, update caller methods in `IxClient` in the same task.
- Do not leave route/client drift for a follow-up task unless explicitly planned.

