class Failure {
    static void fail(String value) {
        throw new IllegalArgumentException(String.format("Invalid record %s: missing field", value));
    }
    public static void main(String[] args) { fail("sample"); }
}
