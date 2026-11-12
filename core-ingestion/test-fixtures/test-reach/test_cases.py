import pytest
from calc import double

class TestArithmetic:
    @pytest.mark.parametrize('value', [1, 2])
    def test_cases(self, value):
        assert double(value) == 2 * value
