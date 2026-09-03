import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

const KERNEL_SOURCE = `
#include <cuda_runtime.h>

__global__ void fused_attn(const float* q, float* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  __shared__ float tile[128];
  if (i < n) out[i] = q[i];
}

void launch_attn(const float* q, float* out, int n) {
  fused_attn<<<(n + 127) / 128, 128>>>(q, out, n);
}
`;

const callTargets = (result: ReturnType<typeof parseFile>) =>
  result!.relationships
    .filter((relationship) => relationship.predicate === 'CALLS')
    .map((relationship) => relationship.dstName);

describe('CUDA', () => {
  it('extracts kernels and host functions from a .cu file', () => {
    const result = parseFile('/repo/kernels/attn.cu', KERNEL_SOURCE);

    expect(result).not.toBeNull();
    expect(result!.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(['fused_attn', 'launch_attn']),
    );
  });

  it('keeps the host -> kernel edge across the launch config', () => {
    // The whole point: tree-sitter-cpp drops the call entirely when it chokes
    // on `<<<...>>>`, so without the blanking pass this edge does not exist.
    expect(callTargets(parseFile('/repo/kernels/attn.cu', KERNEL_SOURCE)))
      .toEqual(expect.arrayContaining(['fused_attn']));
  });

  it('handles a launch config spanning several lines without shifting line numbers', () => {
    const source = `void launch(float* x) {
  my_kernel<<<
    dim3(1, 2, 3),
    256
  >>>(x);
}

__global__ void trailing_marker(int a) {}
`;
    const result = parseFile('/repo/kernels/multiline.cu', source);

    expect(callTargets(result)).toEqual(expect.arrayContaining(['my_kernel']));

    // `trailing_marker` sits on line 8; a space-only blank would have collapsed
    // the newlines inside the launch config and dragged it upwards.
    const marker = result!.entities.find((entity) => entity.name === 'trailing_marker');
    expect(marker).toBeDefined();
    expect(marker!.lineStart).toBe(8);
  });

  it('parses .cuh headers', () => {
    const result = parseFile(
      '/repo/kernels/attn.cuh',
      '__global__ void fused_attn(const float* q, float* out, int n);\n',
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(['fused_attn']),
    );
  });

  it('leaves ordinary C++ untouched', () => {
    // Nested templates, shift operators and arrows inside a string literal all
    // contain the `<<<` / `>>>` character runs; none is a launch config.
    const source = `#include <vector>
void f(std::vector<std::vector<std::vector<int>>>& v, int a, int b) {
  int x = a << b;
  log("<<<HEAD>>>");
  consume(v, x);
}
`;
    const cpp = parseFile('/repo/src/plain.cpp', source);
    const cu = parseFile('/repo/src/plain.cu', source);

    expect(callTargets(cu)).toEqual(callTargets(cpp));
    expect(callTargets(cu)).toEqual(expect.arrayContaining(['consume']));
  });
});
