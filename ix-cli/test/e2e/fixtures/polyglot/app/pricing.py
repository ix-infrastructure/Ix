"""Discounts and tax."""

from app.utils import clamp

TAX_RATE = 0.08


def apply_discount(amount, percent):
    return int(amount * (100 - clamp(percent, 0, 100)) / 100)


def add_tax(amount):
    return int(round(amount * (1 + TAX_RATE)))


def total_for(order, percent=0):
    return add_tax(apply_discount(order.subtotal(), percent))
