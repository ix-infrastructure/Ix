class Order {
  status = "NEW";
  ship() {
    function unknown() {
      this.status = "BAD";
    }
    this.status = compute();
    this.status += "SUFFIX";
  }
}
function shadow(order: Order, other: any) {
  order = other;
  order.status = "BAD";
}
function propertyNamedMethod(order: Order) {
  return order.ship;
}
