import * as fs from "node:fs";
import * as path from "node:path";
import { mapBaselinePath } from "./config.js";
import { isRev, type IngestBaseline } from "./ingest-baseline.js";

interface SerializedMapBaseline {
  root: string;
  sourceRev: number;
}

export interface MapBaseline {
  sourceRev: number;
}

export function loadMapBaseline(projectRoot: string): MapBaseline | null {
  try {
    const data = JSON.parse(
      fs.readFileSync(mapBaselinePath(projectRoot), "utf-8"),
    ) as SerializedMapBaseline;
    if (data.root !== projectRoot || !isRev(data.sourceRev)) {
      return null;
    }
    return { sourceRev: data.sourceRev };
  } catch {
    return null;
  }
}

export function saveMapBaseline(projectRoot: string, sourceRev: number): boolean {
  if (!isRev(sourceRev)) return false;
  try {
    const data: SerializedMapBaseline = {
      root: projectRoot,
      sourceRev,
    };
    fs.mkdirSync(path.dirname(mapBaselinePath(projectRoot)), { recursive: true });
    fs.writeFileSync(mapBaselinePath(projectRoot), JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function hasCurrentMapBaseline(projectRoot: string, sourceRev: number): boolean {
  return loadMapBaseline(projectRoot)?.sourceRev === sourceRev;
}

/**
 * Whether `baseline`'s source revision has a completed architecture map.
 *
 * A baseline written before the marker existed carries no `tracksMapBaseline`,
 * and for those the answer is yes without a marker to show for it. That is not
 * a guess: the CLI that wrote the baseline answered this question with "does an
 * ingest baseline exist", and answered it *yes*. Reversing that on upgrade
 * would turn `ix doctor` red on every existing workspace simultaneously, for a
 * hierarchy nobody has re-examined — and the remedy on offer, `ix map`, is what
 * they already ran.
 *
 * It expires on its own. The next ingest rewrites the baseline with the flag
 * set, from which point only a real marker answers yes, so a workspace whose
 * map genuinely never completed is caught the first time it is re-mapped. A
 * baseline written by this version is never grandfathered, so the state #525
 * is about — a fresh workspace whose patches half-committed — is unaffected.
 */
export function hasCompletedMapFor(projectRoot: string, baseline: IngestBaseline): boolean {
  if (hasCurrentMapBaseline(projectRoot, baseline.currentRev)) return true;
  return !baseline.tracksMapBaseline && loadMapBaseline(projectRoot) === null;
}
