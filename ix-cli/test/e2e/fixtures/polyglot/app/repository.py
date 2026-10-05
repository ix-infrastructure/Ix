"""In-memory persistence."""

from app.utils import to_snake_case


class Repository:
    def __init__(self):
        self._rows = {}

    def save(self, entity):
        key = to_snake_case(type(entity).__name__)
        self._rows.setdefault(key, []).append(entity)
        return len(self._rows[key])

    def find_all(self, kind):
        return list(self._rows.get(to_snake_case(kind), []))
