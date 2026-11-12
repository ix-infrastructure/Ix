class Order {
  constructor() {
    this.status = "NEW";
  }
  ship() {
    this.status = "SHIPPED";
    return this.status;
  }
}
function update() {
  const order = new Order();
  order.status = "DONE";
  return order.status;
}
function unknown(order) {
  order.status = "BAD";
  return order.status;
}
