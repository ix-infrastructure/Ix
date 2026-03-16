export interface PatchSource {
  uri: string;
  sourceHash?: string;
  extractor: string;
  sourceType: string;
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
