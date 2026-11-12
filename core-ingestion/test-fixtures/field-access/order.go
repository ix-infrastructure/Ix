package shop

type Order struct {
    Status string
    Count int
}
func (o *Order) Ship() string {
    o.Status = "SHIPPED"
    o.Count += 1
    return o.Status
}
func update(o *Order) string {
    o.Status = "DONE"
    return o.Status
}
func create() Order {
    return Order{Status: "NEW", Count: 0}
}
func unknown(o interface{}) {
    o.Status = "BAD"
}
