"""String and money helpers shared by the billing modules."""

import re


def to_snake_case(name):
    """Convert CamelCase to snake_case."""
    first = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", first).lower()


def slugify(text):
    """Lower-case, dash-separated identifier for a display name."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def format_money(cents, currency="USD"):
    """Render an integer amount of cents."""
    return f"{currency} {cents // 100}.{cents % 100:02d}"


def clamp(value, low, high):
    """Bound value to [low, high]."""
    return max(low, min(high, value))
