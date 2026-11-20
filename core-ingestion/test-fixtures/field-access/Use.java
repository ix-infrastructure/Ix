import shop.Model;
class Use {
    String finish(Model order) {
        order.status = "DONE";
        return order.status;
    }
}
