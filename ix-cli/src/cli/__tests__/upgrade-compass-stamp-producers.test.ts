import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCompassStamp } from "../commands/upgrade.js";

/**
 * `compass/.version` has three producers and one reader, in different languages,
 * none of which import each other:
 *
 *   .github/workflows/release.yml   the bundle shipped inside a release tarball
 *   scripts/install/install.sh      a tarball that predates the stamp
 *   scripts/install/install.ps1     the same, on Windows
 *   parseCompassStamp()             the reader, in this package
 *
 * Nothing else couples them. The producers are shell/YAML string literals, so a
 * change there typecheks nowhere and no unit test touching only the reader can
 * notice — which is exactly how #376 happened in the first place, and how the
 * multi-line `key=value` shape nearly shipped.
 *
 * These cases read the real files and push the literal each one writes through
 * the real parser. Two properties matter:
 *
 *  1. **It parses as a release bundle.** A producer that loses its `+release`
 *     marker silently re-labels its bundle dist-series, and `ix upgrade` will
 *     downgrade it to an older ix-compass-dist build.
 *  2. **It stays on ONE line.** Every already-shipped CLI reads this file with
 *     `readFileSync(...).trim()` — the whole file — and feeds it to
 *     `splitVersion`. A second line makes the major parse as NaN -> 0, so an old
 *     CLI sees a 1.x release as [0,0,0] and replaces the newer bundle it just
 *     installed with ix-compass-dist. The reader we control cannot fix that;
 *     only the producers can, by never writing a second line.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf-8");

/** What the producer's format literal renders to for a given version. */
const SAMPLE_VERSION = "1.4.2";
const SAMPLE_SHA = "7f98724";

describe("compass .version producers agree with parseCompassStamp", () => {
  const cases: { name: string; file: string; render: (src: string) => string }[] = [
    {
      name: "release.yml (release tarball)",
      file: ".github/workflows/release.yml",
      render: (src) => {
        // printf '%s+release.%s\n' "$VERSION" "${COMPASS_SHA:-unknown}"
        const m = src.match(/printf\s+'([^']*)'\s*\\?\s*\n?\s*"\$VERSION"\s+"\$\{COMPASS_SHA[^}]*\}"/);
        expect(m, "release.yml no longer writes the stamp with a recognisable printf").toBeTruthy();
        return m![1]!.replace(/\\n/g, "\n").replace("%s", SAMPLE_VERSION).replace("%s", SAMPLE_SHA);
      },
    },
    {
      name: "install.sh",
      file: "scripts/install/install.sh",
      render: (src) => {
        // printf '%s+release\n' "$VERSION" > ".../compass/.version"
        const m = src.match(/printf\s+'([^']*)'\s+"\$VERSION"\s*>\s*"[^"]*compass\/\.version"/);
        expect(m, "install.sh no longer writes the stamp with a recognisable printf").toBeTruthy();
        return m![1]!.replace(/\\n/g, "\n").replace("%s", SAMPLE_VERSION);
      },
    },
    {
      name: "install.ps1",
      file: "scripts/install/install.ps1",
      render: (src) => {
        // [System.IO.File]::WriteAllText($CompassStamp, "$Version+release`n")
        const m = src.match(/WriteAllText\(\$CompassStamp,\s*"([^"]*)"\)/);
        expect(m, "install.ps1 no longer writes the stamp with a recognisable WriteAllText").toBeTruthy();
        // PowerShell escapes: backtick-n is a newline; $Version interpolates.
        return m![1]!.replace(/`n/g, "\n").replace("$Version", SAMPLE_VERSION);
      },
    },
  ];

  for (const { name, file, render } of cases) {
    it(`${name} writes a stamp the reader classifies as release`, () => {
      const stamp = render(read(file));
      expect(parseCompassStamp(stamp)).toEqual({ source: "release", version: SAMPLE_VERSION });
    });

    it(`${name} writes exactly one line`, () => {
      const stamp = render(read(file));
      // A trailing newline is fine; an interior one is the regression.
      expect(stamp.trimEnd()).not.toContain("\n");

      // And the property that actually protects old CLIs: their whole-file read
      // must still compare as the Ix version, never as 0.
      const asShippedCliReadsIt = stamp.trim();
      expect(asShippedCliReadsIt.split("+")[0]).toBe(SAMPLE_VERSION);
    });
  }
});
