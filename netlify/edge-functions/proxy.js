const TARGET_URL = "https://cine-hub-blocked.netlify.app";

export default async (request, context) => {
    const url = new URL(request.url);
    const path = url.pathname + url.search;

    // 1. OBLITERATE CORS PREFLIGHT CHECKS
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "*",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Max-Age": "86400",
            }
        });
    }

    let fetchUrl;
    if (path.startsWith("/___proxy___/")) {
        let actualUrl = path.replace("/___proxy___/", "");
        actualUrl = actualUrl.replace(/^(https?:\/)([^\/])/, '$1/$2');
        fetchUrl = actualUrl;
    } else {
        fetchUrl = TARGET_URL + (path === "/" ? "" : path);
    }

    // 2. PERFECT HEADER SPOOFING
    const headers = new Headers(request.headers);
    try {
        const targetUrlObj = new URL(fetchUrl);
        headers.set("Host", targetUrlObj.host);
        headers.set("Origin", targetUrlObj.origin);
        headers.set("Referer", targetUrlObj.origin + "/");
        headers.set("Sec-Fetch-Site", "same-origin"); // Trick API into thinking we are on the original site
        headers.delete("X-Forwarded-For");
    } catch(e) {}

    const fetchOptions = {
        method: request.method,
        headers: headers,
        redirect: "manual"
    };

    if (["POST", "PUT", "PATCH"].includes(request.method) && request.body) {
        fetchOptions.body = request.body;
    }

    try {
        const response = await fetch(fetchUrl, fetchOptions);
        const newHeaders = new Headers(response.headers);

        // 3. HANDLE REDIRECTS
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = newHeaders.get("location");
            if (location) {
                if (location.startsWith("/")) {
                    newHeaders.set("location", url.origin + location);
                } else if (location.startsWith(TARGET_URL)) {
                    newHeaders.set("location", location.replace(TARGET_URL, url.origin));
                } else {
                    newHeaders.set("location", url.origin + "/___proxy___/" + location);
                }
            }
        }

        // 4. NUKE ALL SECURITY HEADERS
        const headersToRemove = [
            "x-frame-options", "content-security-policy", "content-security-policy-report-only",
            "x-content-type-options", "strict-transport-security", "cross-origin-embedder-policy",
            "cross-origin-opener-policy", "cross-origin-resource-policy"
        ];
        headersToRemove.forEach(h => newHeaders.delete(h));
        
        newHeaders.set("access-control-allow-origin", "*");
        newHeaders.set("access-control-allow-methods", "*");
        newHeaders.set("access-control-allow-headers", "*");

        let body = response.body;
        const contentType = newHeaders.get("content-type") || "";

        // 5. THE ULTIMATE HTML INJECTION
        if (contentType.includes("text/html")) {
            let text = await response.text();

            text = text.replaceAll(TARGET_URL, url.origin);

            const injectScript = `
            <script>
                // A. KILL ALL SERVICE WORKERS (They block our proxy)
                if ('serviceWorker' in navigator) {
                    navigator.serviceWorker.getRegistrations().then(function(registrations) {
                        for(let registration of registrations) {
                            registration.unregister();
                        }
                    });
                    // Prevent site from registering new ones
                    navigator.serviceWorker.register = async function() { return null; };
                }

                // B. HOOK FETCH & XHR
                const originalFetch = window.fetch;
                const originalOpen = XMLHttpRequest.prototype.open;

                function rewriteUrl(reqUrl) {
                    try {
                        if (typeof reqUrl === 'string' && reqUrl.startsWith('http')) {
                            let targetOrigin = new URL(reqUrl).origin;
                            if (targetOrigin !== window.location.origin && !reqUrl.includes('/___proxy___/')) {
                                return '/___proxy___/' + reqUrl;
                            }
                        }
                    } catch(e){}
                    return reqUrl;
                }

                window.fetch = async function() {
                    let args = arguments;
                    try {
                        let reqUrl = typeof args[0] === 'string' ? args[0] : args[0].url;
                        if (typeof args[0] === 'string') {
                            args[0] = rewriteUrl(args[0]);
                        } else {
                            args[0] = new Request(rewriteUrl(reqUrl), args[0]);
                        }
                    } catch(e){}
                    return originalFetch.apply(this, args);
                };

                XMLHttpRequest.prototype.open = function(method, reqUrl, ...rest) {
                    return originalOpen.call(this, method, rewriteUrl(reqUrl), ...rest);
                };

                // C. SPOOF [native code] SO ANTI-CHEAT SCRIPTS DON'T CRASH
                const nativeToString = Function.prototype.toString;
                Function.prototype.toString = function() {
                    if (this === window.fetch || this === XMLHttpRequest.prototype.open || this === navigator.serviceWorker.register) {
                        return "function fetch() { [native code] }";
                    }
                    return nativeToString.call(this);
                };

                // D. HIJACK THE DOM (Catches dynamically created <video src="..."> and <script src="...">)
                const originalSetAttribute = Element.prototype.setAttribute;
                Element.prototype.setAttribute = function(name, value) {
                    if ((name === 'src' || name === 'href') && typeof value === 'string' && value.startsWith('http')) {
                        value = rewriteUrl(value);
                    }
                    return originalSetAttribute.call(this, name, value);
                };
            </script>
            `;

            if (text.match(/<head>/i)) {
                text = text.replace(/<head>/i, "<head>\n" + injectScript);
            } else {
                text = injectScript + "\n" + text;
            }
            
            body = text;
            newHeaders.delete("content-length");
            newHeaders.delete("content-encoding"); 
        }

        return new Response(body, {
            status: response.status,
            headers: newHeaders,
        });

    } catch (error) {
        return new Response("Proxy Error: " + error.message, { status: 500 });
    }
};
