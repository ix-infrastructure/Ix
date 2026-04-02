import logging
from retry_handler import RetryHandler

class BillingService:
    """Handles billing operations with retry logic."""

    def __init__(self, api_key):
        self.api_key = api_key
        self.retry_handler = RetryHandler(max_retries=3)
        self.logger = logging.getLogger(__name__)

    def process_payment(self, amount, currency="USD"):
        """Process a payment with automatic retry."""
        def _do_payment():
            # Simulate payment processing
            return {"status": "success", "amount": amount, "currency": currency}

        return self.retry_handler.execute(_do_payment)

    def refund(self, transaction_id):
        """Issue a refund for a transaction."""
        self.logger.info(f"Refunding transaction {transaction_id}")
        return {"status": "refunded", "transaction_id": transaction_id}

def calculate_tax(amount, rate=0.1):
    """Calculate tax for a given amount."""
    return amount * rate
