class Order:
    def __init__(self):
        self.status = "NEW"
        self.count = 0
    def ship(self):
        self.status = "SHIPPED"
        self.count += 1
        return self.status

def update(order: Order):
    order.status = Status.DONE
    return order.status

def unknown(order):
    order.status = "BAD"
    return order.status
