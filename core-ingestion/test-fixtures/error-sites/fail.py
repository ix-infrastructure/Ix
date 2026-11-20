def fail(value):
    raise ValueError(f"Invalid record {value}: missing field")

fail("sample")
