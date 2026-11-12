class Implicit {
    String status;
    int count;
    Implicit() {
        status = "NEW";
    }
    String ship() {
        status = "DONE";
        count++;
        String previous = status;
        status.length();
        return status;
    }
    void shadow(String status) {
        status = "LOCAL";
    }
}
