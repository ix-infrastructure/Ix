These source fixtures produce deterministic failures. `python.trace`,
`v8.trace`, `go.trace` and `jvm.trace` were recorded by running `fail.py` with
Python, `fail.js` with Node, `go run fail.go`, and `java Failure.java` (source-file
mode), respectively. Absolute source directories were replaced with
`/reporter/project/src`; the JVM environment-options banner was omitted.
Line numbers, exception messages, frame order and runtime frames are retained.
The Scala and Windows tests additionally exercise alternate JVM/V8 frame syntax.

`goroutines.trace` was recorded with `GOTRACEBACK=all go run goroutine-main.go
goroutine-worker.go`. It retains separate running and waiting goroutine stacks,
with the same source-directory replacement as the other recordings.
