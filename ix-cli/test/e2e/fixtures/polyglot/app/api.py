"""Entry points the CLI calls."""

from app.events import subscribe
from app.services import BillingService, receipt

_service = BillingService()
_log = []


def _record(payload):
    _log.append(payload)


def register():
    subscribe("order.charged", _record)
    return _service


def checkout(name, email, items):
    service = register()
    user = service.create_user(name, email)
    return receipt(service, user, items)
