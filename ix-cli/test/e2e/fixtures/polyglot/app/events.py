"""A tiny event bus."""

_handlers = {}


def subscribe(name, handler):
    _handlers.setdefault(name, []).append(handler)


def publish(name, payload):
    for handler in _handlers.get(name, []):
        handler(payload)
    return len(_handlers.get(name, []))
