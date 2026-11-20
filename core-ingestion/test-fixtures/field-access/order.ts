class Order {
  status: string;
  count = 0;
  constructor() {
    this.status = "NEW";
  }
  ship() {
    this.status = "SHIPPED";
    this.count += 1;
    return this.status;
  }
}
function update(order: Order) {
  order.status = Status.DONE;
  return order.status;
}
function unknown(order: any) {
  order.status = "BAD";
  return order.status;
}
enum Status { DONE = "DONE" }
