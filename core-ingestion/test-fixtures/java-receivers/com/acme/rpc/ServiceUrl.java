package com.acme.rpc;

import com.acme.common.URL;

public class ServiceUrl extends URL {
    public ServiceUrl(String host) {
        super(host);
    }

    @Override
    public String getMethodParameter(String method, String key) {
        return super.getMethodParameter(method, key);
    }

    public String describe() {
        return this.getHost() + getProtocol();
    }
}
