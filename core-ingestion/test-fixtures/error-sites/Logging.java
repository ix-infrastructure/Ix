class Logging {
    static class Log {
        void error(String template, Object value) {}
        void warn(String template, Object value) {}
    }
    final Log log = new Log();
    void validate(String value) {
        log.error("Unable to decode record {}", value);
        log.warn("Discarded invalid record {}", value);
        throw new RuntimeException("Unsupported record " + value + ": invalid type");
    }
}
