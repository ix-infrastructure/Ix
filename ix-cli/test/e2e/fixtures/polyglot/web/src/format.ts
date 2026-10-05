import { clamp, multiply } from "./math";

export function formatPercent(ratio: number): string {
  return `${Math.round(multiply(clamp(ratio, 0, 1), 100))}%`;
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
