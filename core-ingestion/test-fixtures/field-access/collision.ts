class First { status = "NEW"; run() { this.status = "A"; } }
class Second { status = "NEW"; run() { this.status = "B"; } }
function bare() { status(); }
function member(first: First) { first.status(); }
class OnlyFields { lone = "FIELD"; }
function unrelated() { lone(); }
