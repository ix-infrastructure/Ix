package com.acme.common;

public class URL extends AbstractURL implements Node {
    private final String host;

    public URL(String host) {
        this.host = host;
    }

    public static URL valueOf(String text) {
        return new URL(text);
    }

    public String getMethodParameter(String method, String key) {
        return key;
    }

    public String getMethodParameter(String method, String key, String defaultValue) {
        return defaultValue;
    }

    public int getMethodParameter(String method, String key, int defaultValue) {
        return defaultValue;
    }

    public String getHost() {
        return host;
    }

    @Override
    public boolean isAvailable() {
        return getMethodParameter("ping", "enabled") != null;
    }
}
