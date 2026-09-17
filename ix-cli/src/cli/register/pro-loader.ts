import type { Command } from "commander";

export async function tryLoadProCommands(program: Command): Promise<boolean> {
  let specifier: string;
  try {
    specifier = import.meta.resolve("@ix/pro/register");
  } catch (error) {
    const e = error as { code?: string; message?: string };
    // Pro is optional for OSS installs. An installed-but-broken plugin is not
    // absence: silently falling back would run commands without its auth guard.
    if (e.code === "ERR_MODULE_NOT_FOUND" && e.message?.startsWith("Cannot find package '@ix/pro'")) {
      return false;
    }
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
