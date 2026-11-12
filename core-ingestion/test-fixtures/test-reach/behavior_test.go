package arithmetic

import "testing"

func TestDoubles(t *testing.T) {
    if Double(2) != 4 { t.Fatal("wrong result") }
}
