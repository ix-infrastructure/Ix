import type { Command } from "commander";

export async function tryLoadProCommands(program: Command): Promise<boolean> {
  try {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)"
    ) as (specifier: string) => Promise<any>;

    const mod = await dynamicImport("@ix/pro/register");

    if (mod?.registerProCommands) {
      mod.registerProCommands(program);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
