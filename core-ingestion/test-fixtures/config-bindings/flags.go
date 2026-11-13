package main
import "flag"
var verbose bool
func setup() {
  flag.BoolVar(&verbose, "verbose", false, "Verbose")
  println(verbose)
  local := flag.String("output-dir", "", "Output")
  println(*local)
  {
    local := "unrelated"
    println(local)
  }
}
func run() { println(verbose) }
func unrelated(verbose bool, local string) { println(verbose, local) }
