import { add, multiply } from "./math";
import { formatPrice } from "./format";
import { Store } from "./store";
import type { LineItem } from "./types";

export class Cart {
  private readonly lines: LineItem[] = [];

  constructor(private readonly store: Store<LineItem[]>) {}

  addLine(line: LineItem): void {
    this.lines.push(line);
  }

  total(): number {
    return this.lines.reduce((sum, line) => add(sum, multiply(line.price, line.quantity)), 0);
  }

  summary(): string {
    return `${this.lines.length} items, ${formatPrice(this.total())}`;
  }

  save(id: string): void {
    this.store.set(id, [...this.lines]);
  }
}
