package shop
func finish(order *Order) string {
    order.Status = "DONE"
    return order.Status
}
