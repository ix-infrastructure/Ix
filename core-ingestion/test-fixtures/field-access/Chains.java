class Alpha { String status; }
class Beta { String status; }
class Root {
    Alpha alpha() { return new Alpha(); }
    Beta beta() { return new Beta(); }
}
class Chains {
    void update(Root root) {
        root.alpha().status = "A";
        root.beta().status = "B";
    }
}
