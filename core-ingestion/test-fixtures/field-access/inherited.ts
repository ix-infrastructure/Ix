class Base {
  status = "NEW";
  callback: () => void;
}
class Child extends Base {
  constructor(private label: string) { super(); }
  ship() {
    this.status = "DONE";
    this.callback();
    return this.status;
  }
}
