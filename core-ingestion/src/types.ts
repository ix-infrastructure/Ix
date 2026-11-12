// Copyright 2026 Ix Infrastructure Inc.

// The op shapes, node kinds and edge predicates are defined in schema.ts.
import type { PatchOp } from './schema.js';

export type { PatchOp };

export interface PatchSource {
  // uri is the provenance source URI. In the client-agnostic backend design it
  // is a workspace-relative path (POSIX separators), not an absolute host path.
  uri: string;
  sourceHash?: string;
  extractor: string;
  sourceType: string;
  // workspaceId uniquely identifies the workspace whose files produced this
  // patch. Derived client-side (SHA-256 of workspace root abs path). Backend
  // stores it as an opaque attribute.
  workspaceId?: string;
  // Multi-repo co-ingest (Ix#225 Path 1). systemId groups the repos ingested as
  // one system; repoId is this file's repo. Both optional => single-repo ingest.
  systemId?: string;
  repoId?: string;
}


export interface GraphPatchPayload {
  patchId: string;
  actor: string;
  timestamp: string;
  source: PatchSource;
  baseRev: number;
  ops: PatchOp[];
  replaces: string[];
  intent?: string;
}
