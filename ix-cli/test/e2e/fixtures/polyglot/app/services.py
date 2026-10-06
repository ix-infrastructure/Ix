"""Billing use cases."""

from app.events import publish
from app.models import Order, User
from app.pricing import total_for
from app.repository import Repository
from app.utils import format_money


class BillingService:
    def __init__(self, repository=None):
        self.repository = repository or Repository()

    def create_user(self, name, email):
        user = User(name, email)
        self.repository.save(user)
        publish("user.created", user)
        return user

    def charge(self, user, items, percent=0):
        order = Order(user, items)
        self.repository.save(order)
        amount = total_for(order, percent)
        publish("order.charged", order)
        return format_money(amount)


def receipt(service, user, items):
    return service.charge(user, items) + " for " + user.display_name()
