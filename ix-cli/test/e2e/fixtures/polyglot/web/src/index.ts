import { Cart } from "./cart";
import { on } from "./events";
import { formatPercent } from "./format";
import { Store } from "./store";

export function run(): string {
  on((event) => console.log(event));
  const cart = new Cart(new Store());
  cart.addLine({ sku: "book", price: 1250, quantity: 1 });
  cart.save("demo");
  return `${cart.summary()} (${formatPercent(0.08)} tax)`;
}
