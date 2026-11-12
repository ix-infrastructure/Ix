import { Order as Purchase } from './order';
export function finish(order: Purchase) {
  order.status = "DONE";
  order.status = "ARCHIVED";
  return order.status;
}
export function opaque(order: unknown) {
  order.status = "BAD";
}
