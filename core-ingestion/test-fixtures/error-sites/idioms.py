import logging

def validate(value):
    logging.error("Unable to decode record %s", value)
    logging.warning("Discarded invalid record %s" % value)
    raise RuntimeError("Unsupported record {}: invalid type".format(value))

# raise ValueError("Comment is not an error site")
ordinary = 'raise ValueError("Text is not an error site")'
