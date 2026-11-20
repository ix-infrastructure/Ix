class Order {
    String status;
    int count;
    Order() {
        this.status = "NEW";
    }
    String ship() {
        this.status = "SHIPPED";
        this.count += 1;
        return this.status;
    }
    static String update(Order order) {
        order.status = Status.DONE;
        return order.status;
    }
    static void unknown(Object order) {
        order.status = "BAD";
    }
}
enum Status { DONE }
