package com.acme.rpc;

import com.acme.common.URL;
import com.acme.common.*;

public class TimeoutFilter {
    private URL url;
    private Node node;

    // Same name as URL's method: the same-file tier used to claim the calls below.
    public String getMethodParameter(String method, String key) {
        return key;
    }

    public void invoke(Invoker invoker, URL param) {
        String method = RpcUtils.methodName(invoker);
        URL local = URL.valueOf("acme://host");
        local.getMethodParameter(method, "timeout");
        param.getMethodParameter(method, "retries", 3);
        url.getMethodParameter(method, "weight", "1");
        this.url.getMethodParameter(method, "weight");
        invoker.getUrl().getMethodParameter(method, "x");
        node.isAvailable();
        var service = new ServiceUrl("h");
        service.getProtocol();
    }
}
