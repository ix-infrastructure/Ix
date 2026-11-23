// Copyright 2026 Ix Infrastructure Inc.
// Paired percentile bootstrap for a pilot workload. Keep each observed A/B pair
// together, and resample process sessions before their pairs when there are several.
// With few independent sessions these are descriptive intervals, not a release certificate.
export function pairedGate(samples, percentile, ceiling, sessions = 1, averageMiddle = true) {
  const [a, b] = samples;
  if (!a.length || a.length !== b.length || a.length % sessions !== 0)
    throw new Error("expected equally sized paired sessions");
  function quantile(values, q) {
    const sorted = values.toSorted((x, y) => x - y);
    if (averageMiddle && q === 0.5)
      return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
    return sorted[Math.ceil(q * sorted.length) - 1];
  }
  const change = (before, after) =>
    100 * (quantile(after, percentile) / quantile(before, percentile) - 1);
  let seed = 73032;
  const pick = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * n);
  };
  const estimates = [];
  const width = a.length / sessions;
  for (let boot = 0; boot < 3000; boot++) {
    const before = [],
      after = [];
    for (let s = 0; s < sessions; s++) {
      const offset = pick(sessions) * width;
      for (let i = 0; i < width; i++) {
        const index = offset + pick(width);
        before.push(a[index]);
        after.push(b[index]);
      }
    }
    estimates.push(change(before, after));
  }
  const interval = [quantile(estimates, 0.025), quantile(estimates, 0.975)];
  return {
    percentile,
    ceiling,
    samples: a.length,
    sessions,
    change: change(a, b),
    interval,
    decision: interval[0] > ceiling ? "fail" : interval[1] <= ceiling ? "pass" : "inconclusive",
  };
}
