"""Plain data models."""

from app.utils import slugify


class User:
    def __init__(self, name, email):
        self.name = name
        self.email = email
        self.slug = slugify(name)

    def display_name(self):
        return f"{self.name} <{self.email}>"


class Order:
    def __init__(self, user, items):
        self.user = user
        self.items = list(items)

    def subtotal(self):
        return sum(price for _, price in self.items)

    def describe(self):
        return f"{self.user.display_name()}: {len(self.items)} items"
