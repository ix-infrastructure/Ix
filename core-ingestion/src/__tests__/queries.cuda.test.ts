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

  it('stays linear on adversarial input', () => {
    // Ingest input is an arbitrary repository, so the blanking pass is
    // attacker-controlled. The obvious regex (`/<<<[^;]*?>>>(?=\\s*\\()/g`)
    // backtracks quadratically over a run of `<`; the scan in
    // `blankCudaLaunchConfigs` never rewinds behind its cursor.
    //
    // This is an absolute budget rather than a small-vs-large ratio. Timing
    // one parse against another leaves only the 4x of honest growth between
    // pass and fail, which is thinner than the run-to-run noise on a parse
    // this size -- that comparison failed on macos-14 at a measured 8.08x
    // (Ix CI run 34297232151). A budget at an input size where the two
    // implementations are seconds apart has no such overlap. Measured on a
    // dev box at 128k `<`: this scan parses in 146-240ms over 15 runs, while
    // the regex alone spends 8.3s backtracking. 2.5s sits ~10x above the
    // slowest honest run and ~3x below the regression it guards. The test
    // timeout is above the budget so a quadratic pass reports the assertion
    // and its measured cost, not a bare vitest timeout.
    const evil = `void f() { ${'<'.repeat(128_000)}>>>x }`;

    parseFile('/repo/warm.cu', `void f() { ${'<'.repeat(1_000)}>>>x }`);

    const started = performance.now();
    parseFile('/repo/evil.cu', evil);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(2_500);
  }, 30_000);

});
