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
}

export interface PatchOp {
  type: string;
  [key: string]: unknown;
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
