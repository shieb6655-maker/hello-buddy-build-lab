/**
 * Standalone Cloudflare Worker Entry
 * FanCode Stream Proxy — TypeScript
 */
import { handleFanCodeRequest, USAGE_DOC, CORS_HEADERS } from "./lib/fancode-proxy";

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "") {
      return new Response(USAGE_DOC, {
        headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
      });
    }

    const res = await handleFanCodeRequest(request, env, ctx);
    if (res) {
      return res;
    }

    return new Response(JSON.stringify({ error: "Not found — see / for route docs", status: 404 }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  },
};
