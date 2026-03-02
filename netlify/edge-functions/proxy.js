
const TARGET_URL = "https://cine-hub-blocked.netlify.app";

export default async (request, context) => {
    const url = new URL(request.url);
    const path = url.pathname + url.search;


    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
                "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
                "Access-Control-Max-Age": "86400",
            }
        });
    }

    let fetchUrl;


    if (path.startsWith("/___proxy___/")) {
        let actualUrl = path.replace("/___proxy___/", "");
        actualUrl = actualUrl.replace(/^(https?:\/)([^\/])/, '$1/$2'); // Fix missing slashes
        fetchUrl = actualUrl;
    } else {
        fetchUrl = TARGET_URL + path;
    }


    const headers = new Headers(request.headers);
    try {
        const targetUrlObj = new URL(fetchUrl);
        headers.set("Host", targetUrlObj.host);
        headers.set("Origin", targetUrlObj.origin);
        headers.set("Referer", targetUrlObj.origin + "/");
        headers.set("User-Agent", request.headers.get("user-agent") || "Mozilla/5.0");
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


        newHeaders.delete("x-frame-options");
        newHeaders.delete("content-security-policy");
        newHeaders.delete("x-content-type-options");
        newHeaders.delete("strict-transport-security");
        newHeaders.set("access-control-allow-origin", "*");
        newHeaders.set("access-control-allow-methods", "*");
        newHeaders.set("access-control-allow-headers", "*");

        let body = response.body;
        const contentType = newHeaders.get("content-type") || "";


        if (contentType.includes("text/html")) {
            let text = await response.text();


            text = text.replaceAll(TARGET_URL, url.origin);


            const injectScript = `
            <script>

                const originalFetch = window.fetch;
                window.fetch = async function() {
                    let args = arguments;
                    try {
                        let reqUrl = typeof args[0] === 'string' ? args[0] : args[0].url;
                        if (reqUrl.startsWith('http')) {
                            let targetOrigin = new URL(reqUrl).origin;
                            if (targetOrigin !== window.location.origin && !reqUrl.includes('/___proxy___/')) {
                                if (typeof args[0] === 'string') {
                                    args[0] = '/___proxy___/' + args[0];
                                } else {
                                    args[0] = new Request('/___proxy___/' + reqUrl, args[0]);
                                }
                            }
                        }
                    } catch(e){}
                    return originalFetch.apply(this, args);
                };

                // OVERRIDE XHR (AJAX) TO FORCE THROUGH PROXY
                const originalOpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, reqUrl, ...rest) {
                    try {
                        if (typeof reqUrl === 'string' && reqUrl.startsWith('http')) {
                            let targetOrigin = new URL(reqUrl).origin;
                            if (targetOrigin !== window.location.origin && !reqUrl.includes('/___proxy___/')) {
                                reqUrl = '/___proxy___/' + reqUrl;
                            }
                        }
                    } catch(e){}
                    return originalOpen.call(this, method, reqUrl, ...rest);
                };
            </script>
            `;

            // Insert the script safely into the HTML
            if (text.match(/<head>/i)) {
                text = text.replace(/<head>/i, "<head>\n" + injectScript);
            } else {
                text = injectScript + "\n" + text;
            }
            
            body = text;
            newHeaders.delete("content-length");
            newHeaders.delete("content-encoding"); // Required because we modified the text
        }

        return new Response(body, {
            status: response.status,
            headers: newHeaders,
        });

    } catch (error) {
        return new Response("API/Proxy Error: " + error.message, { status: 500 });
    }
};
