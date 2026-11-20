from order import Order as Purchase

def finish(order: Purchase):
    order.status = "DONE"
    return order.status
