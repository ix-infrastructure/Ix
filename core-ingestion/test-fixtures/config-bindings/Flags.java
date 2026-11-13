import picocli.CommandLine.Option;
class Flags implements Runnable {
  @Option(names = "--output-dir")
  String output;
  public void run() { System.out.println(output.trim()); }
  void explicit(String output) { System.out.println(this.output); }
  void shadow(String output) { System.out.println(output); }
}
class Other {
  String output;
  void unrelated() { System.out.println(output); }
}
