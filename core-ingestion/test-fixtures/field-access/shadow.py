class Order:
    def __init__(self):
        self.status = "NEW"

def shadow(order: Order, items):
    for order in items:
        order.status = "BAD"
    return order.status

def reassigned(order: Order, other):
    order = other
    order.status = "BAD"

class Other:
    @staticmethod
    def unknown(self):
        self.status = "BAD"

def tuple_shadow(order: Order, items):
    order, other = items
    order.status = "BAD"

def constructor_shadow(Order):
    order = Order()
    order.status = "BAD"
