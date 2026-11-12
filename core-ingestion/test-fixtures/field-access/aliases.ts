import { Order, Order as Purchase } from './order';
export function finish(order: Order, purchase: Purchase) {
  order.status = "DONE";
  purchase.status = "ARCHIVED";
}
