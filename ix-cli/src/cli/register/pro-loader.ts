import type { Command } from "commander";

export async function tryLoadProCommands(program: Command): Promise<boolean> {
  try {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)"
    ) as (specifier: string) => Promise<any>;

    const mod = await dynamicImport("@ix/pro/register");

    if (mod?.registerProCommands) {
      // registerProCommands is async: it dynamically imports each command so
      // one broken command can't disable them all. It MUST be awaited here.
      // main.ts calls program.parse() synchronously right after this resolves,
      // so without the await the dynamic imports are still pending and NO pro
      // command is registered in time — every `ix <pro-cmd>` then fails with
      // "unknown command". (Older sync versions of registerProCommands did not
      // need the await; awaiting is safe for both.)
      await mod.registerProCommands(program);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
