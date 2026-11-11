// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";

/** Resolve from this module, so every probe here agrees with the loader. */
const defaultResolve = (specifier: string): string => import.meta.resolve(specifier);

/**
 * True only when `@ix/pro` is not installed at all.
 *
 * A package that is present but exposes no "." export fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED rather than ERR_MODULE_NOT_FOUND, which still
 * proves it is installed — so that counts as present, and the caller fails
 * closed.
 */
function proPackageIsAbsent(resolve: (specifier: string) => string = defaultResolve): boolean {
  try {
    resolve("@ix/pro");
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND";
  }
}

/**
 * True exactly when `tryLoadProCommands` would return false without loading
 * anything: neither `@ix/pro/register` nor the package itself resolves. An
 * installed-but-broken Pro counts as present, so a caller that skips the
 * loader on this answer still leaves the broken case to the loader's error.
 */
export function proIsAbsent(): boolean {
  return proInstallState() === "absent";
}

/** What `proInstallState` found. */
export type ProInstallState = "absent" | "installed" | "broken";

/**
 * Where `@ix/pro` stands, from module resolution alone: nothing is imported or
 * initialized, so this costs two resolutions and has no side effects.
 *
 * - `absent`: the package is not installed (`proIsAbsent`).
 * - `installed`: `@ix/pro/register` resolves, so the loader will try it. Pro
 *   can still fail to initialize; the first command that loads it says so.
 * - `broken`: the package is there but `@ix/pro/register` does not resolve,
 *   which `tryLoadProCommands` refuses to run past.
 *
 * `resolve` is for tests; the default resolves from this module, as the loader
 * does.
 */
export function proInstallState(resolve: (specifier: string) => string = defaultResolve): ProInstallState {
  try {
    resolve("@ix/pro/register");
    return "installed";
  } catch {
    return proPackageIsAbsent(resolve) ? "absent" : "broken";
  }
}

export async function tryLoadProCommands(program: Command): Promise<boolean> {
  let specifier: string;
  try {
    specifier = import.meta.resolve("@ix/pro/register");
  } catch (error) {
    // Pro is optional for OSS installs. An installed-but-broken plugin is not
    // absence: silently falling back would run commands without its auth guard.
    //
    // Which of the two this is gets decided by re-resolving the PACKAGE, not by
    // matching the error text. Every OSS install takes this path on every
    // command, and the else-branch now throws, so a Node reword of "Cannot find
    // package" would have turned a normal OSS install into a CLI that refuses
    // to run anything.
    if (proPackageIsAbsent()) return false;
    throw new Error("Installed Ix Pro could not be resolved. Reinstall the reviewed CLI/Pro pair before running commands.", { cause: error });
  }
  try {
    const mod = await import(specifier);
    if (typeof mod.registerProCommands !== "function") {
      throw new Error("Ix Pro does not export registerProCommands");
    }
    // Await security initialization and command registration before parsing.
    await mod.registerProCommands(program);
    return true;
  } catch (error) {
    throw new Error("Installed Ix Pro could not initialize. Reinstall the reviewed CLI/Pro pair before running commands.", { cause: error });
  }
}
