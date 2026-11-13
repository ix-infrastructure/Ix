package main

import "fmt"

func fail(value string) {
    panic(fmt.Errorf("Invalid record %s: missing field", value))
}

func main() { fail("sample") }
