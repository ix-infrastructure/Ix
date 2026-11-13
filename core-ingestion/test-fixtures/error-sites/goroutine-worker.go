package main

func wait(ready chan struct{}) {
	close(ready)
	select {}
}
