// Copyright 2026 Ix Infrastructure Inc.

// The CLI's configuration surface, as one import path. Every name here lives in
// a focused module (#943); this file only re-exports them, so existing imports
// of `cli/config.js` (including `@ix/pro`'s, through the `./cli/*` package
// export) keep resolving. New code may import the focused module directly.

export * from "./state-paths.js";
export * from "./stitch-scope-cache.js";
export * from "./config-store.js";
export * from "./connection.js";
export * from "./pro-client.js";
export * from "./path-containment.js";
export * from "./workspace.js";
export * from "./read-guard.js";
export { ConfigLockError } from "./config-lock.js";
/** The backend a config with no `endpoint` (or no config at all) points at. */
export { DEFAULT_ENDPOINT } from "./endpoint.js";
