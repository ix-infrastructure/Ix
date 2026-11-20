package main

func fail() {
	panic("Invalid record sample: missing field")
}

func main() {
	ready := make(chan struct{})
	go wait(ready)
	<-ready
	fail()
}
