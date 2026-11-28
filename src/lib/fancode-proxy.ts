/**
 * FanCode Stream Proxy — TypeScript Implementation
 * Clean URL routing: /fancode/<event-slug>/playlist.m3u8
 *
 * Routes:
 *   GET /fancode/<slug>/playlist.m3u8      → proxy + rewrite HLS master for that event
 *   GET /fancode/<slug>/<quality>.m3u8     → proxy + rewrite HLS variant playlist
 *   GET /fancode/<slug>/seg/<encoded-ts>   → proxy TS/fMP4 segment
 *   GET /playlist.m3u8                     → master playlist, all events, clean slug URLs
 *   GET /api/fancode/events                → JSON list of current events for UI
 *
 * Upstream headers:
 *   Referer:    https://www.fancode.com/
 *   Origin:     https://www.fancode.com
 *   User-Agent: Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 ...
 */

export interface FanCodeEvent {
  slug: string;
  cdnUrl: string;
  name: string;
  logo: string;
  streamUrl?: string;
  category?: string;
}

export const UPSTREAM_PLAYLIST = "https://premiumplugx.top/ter/playlist.php";
export const FANCODE_CDN_HOST = "in-mc-plive.fancode.com";

export const FANCODE_HEADERS: Record<string, string> = {
  Referer: "https://www.fancode.com/",
  Origin: "https://www.fancode.com",
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36",
};

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Origin, Accept, Content-Type",
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message, status }, status);
}

// ─── In-Memory Cache (TTL: 60s) ───────────────────────────────────────────────

let cachedPlaylist: { text: string; events: FanCodeEvent[]; timestamp: number } | null = null;
const CACHE_TTL_MS = 60 * 1000;

// ─── Base64 Helpers (URL-safe, cross-platform) ───────────────────────────────

export function b64e(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function b64d(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  const full = padded + "=".repeat(pad);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(full, "base64").toString("utf-8");
  }
  return decodeURIComponent(escape(atob(full)));
}

// ─── URL Utilities ────────────────────────────────────────────────────────────

export function resolveUrl(uri: string, base: string): string {
  if (/^https?:\/\//.test(uri)) return uri;
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

export function resolveBase(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
    u.search = "";
    return u.href;
  } catch {
    return url;
  }
}

export function workerBase(workerUrl: URL): string {
  return `${workerUrl.protocol}//${workerUrl.host}`;
}

export function urlToSlug(streamUrl: string): string {
  try {
    const u = new URL(streamUrl);
    const seg = u.pathname.split("/").find((s) => /^\d{5,}_/.test(s));
    if (seg) return seg.split("_")[0] || "stream";
  } catch {}
  return b64e(streamUrl).replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 32);
}

// ─── Upstream Fetch & Parse ──────────────────────────────────────────────────

export async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 2): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      lastError = e;
      if (i < retries) {
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function parsePlaylistEvents(text: string): FanCodeEvent[] {
  const lines = text.split("\n");
  const events: FanCodeEvent[] = [];
  let lastName = "";
  let lastLogo = "";
  let lastCategory = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trimEnd() ?? "";

    if (line.startsWith("#EXTINF:")) {
      const nameMatch = line.match(/,\s*(.+)$/);
      const logoMatch = line.match(/tvg-logo="([^"]+)"/);
      const groupMatch = line.match(/group-title="([^"]+)"/);

      lastName = nameMatch && nameMatch[1] ? nameMatch[1].trim() : "";
      lastLogo = logoMatch && logoMatch[1] ? logoMatch[1] : "";
      lastCategory = groupMatch && groupMatch[1] ? groupMatch[1] : "Sports";
      continue;
    }

    if (!line.startsWith("#") && line.startsWith("http")) {
      const cdnUrl = line.trim();
      const slug = urlToSlug(cdnUrl);
      events.push({
        slug,
        cdnUrl,
        name: lastName || `FanCode Event ${slug}`,
        logo: lastLogo,
        category: lastCategory || "Sports",
      });
      lastName = "";
      lastLogo = "";
      lastCategory = "";
    }
  }

  return events;
}

export async function fetchUpstreamPlaylist(forceRefresh = false): Promise<{ text: string; events: FanCodeEvent[] }> {
  const now = Date.now();
  if (!forceRefresh && cachedPlaylist && now - cachedPlaylist.timestamp < CACHE_TTL_MS) {
    return { text: cachedPlaylist.text, events: cachedPlaylist.events };
  }

  const res = await fetchWithRetry(UPSTREAM_PLAYLIST, {
    headers: { ...FANCODE_HEADERS },
    // Cloudflare edge cache hint if supported
    // @ts-expect-error CF specific fetch option
    cf: { cacheTtl: 60, cacheEverything: true },
  });

  if (!res.ok) {
    if (cachedPlaylist) {
      // Fallback to stale cache if upstream is temporarily failing
      return { text: cachedPlaylist.text, events: cachedPlaylist.events };
    }
    throw new HttpError(502, `Upstream playlist HTTP ${res.status}`);
  }

  const text = await res.text();
  const events = parsePlaylistEvents(text);
  cachedPlaylist = { text, events, timestamp: now };
  return { text, events };
}

export async function resolveCdnUrl(slug: string): Promise<string> {
  const { events } = await fetchUpstreamPlaylist();
  const entry = events.find((e) => e.slug === slug);
  if (!entry) {
    throw new HttpError(404, `Event slug not found: ${slug}`);
  }
  return entry.cdnUrl;
}

export async function cdnFetch(url: string, rangeHeader?: string | null): Promise<Response> {
  const headers: Record<string, string> = { ...FANCODE_HEADERS };
  if (rangeHeader) {
    headers["Range"] = rangeHeader;
  }
  return fetchWithRetry(url, {
    headers,
    // @ts-expect-error CF specific option
    cf: { cacheTtl: 0 },
  });
}

// ─── Manifest Rewriter ───────────────────────────────────────────────────────

export function rewriteManifest(
  text: string,
  baseUrl: string,
  workerBaseUrl: string,
  slug: string,
  _type: "master" | "variant",
): string {
  const lines = text.split("\n");
  const out: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();

    // EXT-X-KEY
    if (line.startsWith("#EXT-X-KEY") && line.includes('URI="')) {
      out.push(
        line.replace(/URI="([^"]+)"/, (_, uri: string) => {
          const abs = resolveUrl(uri, baseUrl);
          return `URI="${workerBaseUrl}/fancode/${slug}/seg/${encodeURIComponent(b64e(abs))}"`;
        }),
      );
      continue;
    }

    // EXT-X-MEDIA with URI
    if (line.startsWith("#EXT-X-MEDIA") && line.includes('URI="')) {
      out.push(
        line.replace(/URI="([^"]+)"/, (_, uri: string) => {
          const abs = resolveUrl(uri, baseUrl);
          const file = abs.split("/").pop(); // e.g. audio.m3u8
          return `URI="${workerBaseUrl}/fancode/${slug}/${file}"`;
        }),
      );
      continue;
    }

    // EXT-X-STREAM-INF and EXT-X-I-FRAME-STREAM-INF with URI=
    if (
      (line.startsWith("#EXT-X-STREAM-INF") || line.startsWith("#EXT-X-I-FRAME-STREAM-INF")) &&
      line.includes('URI="')
    ) {
      out.push(
        line.replace(/URI="([^"]+)"/, (_, uri: string) => {
          const abs = resolveUrl(uri, baseUrl);
          const file = abs.split("/").pop()?.split("?")[0];
          return `URI="${workerBaseUrl}/fancode/${slug}/${file}"`;
        }),
      );
      continue;
    }

    // Non-comment, non-empty URI line
    if (!line.startsWith("#") && line.trim() !== "") {
      const abs = resolveUrl(line.trim(), baseUrl);
      const isPlaylist = abs.split("?")[0]?.endsWith(".m3u8");

      if (isPlaylist) {
        const file = abs.split("/").pop()?.split("?")[0];
        out.push(`${workerBaseUrl}/fancode/${slug}/${file}`);
      } else {
        out.push(`${workerBaseUrl}/fancode/${slug}/seg/${encodeURIComponent(b64e(abs))}`);
      }
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

export async function serveMasterPlaylist(workerUrl: URL): Promise<Response> {
  const { text } = await fetchUpstreamPlaylist();
  const base = workerBase(workerUrl);

  const lines = text.split("\n");
  const out: string[] = [];
  let pendingExtinf: string | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith("#EXTINF:")) {
      pendingExtinf = line;
      continue;
    }

    if (!line.startsWith("#") && line.startsWith("http")) {
      const slug = urlToSlug(line);
      if (pendingExtinf) {
        out.push(pendingExtinf);
        pendingExtinf = null;
      }
      out.push(`${base}/fancode/${slug}/playlist.m3u8`);
      continue;
    }

    if (pendingExtinf) {
      out.push(pendingExtinf);
      pendingExtinf = null;
    }
    out.push(line);
  }

  return new Response(out.join("\n"), {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

export async function serveEventMaster(slug: string, workerUrl: URL, request: Request): Promise<Response> {
  const cdnMasterUrl = await resolveCdnUrl(slug);
  const upstream = await cdnFetch(cdnMasterUrl, request.headers.get("Range"));

  if (!upstream.ok && upstream.status !== 206) {
    throw new HttpError(upstream.status, "CDN master fetch failed");
  }

  const text = await upstream.text();
  const base = workerBase(workerUrl);
  const baseUrl = resolveBase(cdnMasterUrl);
  const rewritten = rewriteManifest(text, baseUrl, base, slug, "master");

  return new Response(rewritten, {
    status: upstream.status,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

export async function serveVariant(slug: string, qualityFile: string, workerUrl: URL, request: Request): Promise<Response> {
  const cdnMasterUrl = await resolveCdnUrl(slug);
  const baseUrl = resolveBase(cdnMasterUrl);
  const cdnVariantUrl = baseUrl + qualityFile;

  const upstream = await cdnFetch(cdnVariantUrl, request.headers.get("Range"));
  if (!upstream.ok && upstream.status !== 206) {
    throw new HttpError(upstream.status, "CDN variant fetch failed");
  }

  const text = await upstream.text();
  const base = workerBase(workerUrl);
  const rewritten = rewriteManifest(text, baseUrl, base, slug, "variant");

  return new Response(rewritten, {
    status: upstream.status,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

export async function serveSegment(_slug: string, encodedSeg: string, request: Request): Promise<Response> {
  let segUrl: string;
  try {
    segUrl = b64d(decodeURIComponent(encodedSeg));
  } catch {
    throw new HttpError(400, "Malformed segment path encoding");
  }

  if (!segUrl.includes(FANCODE_CDN_HOST)) {
    throw new HttpError(403, "Segment not from fancode CDN");
  }

  const rangeHeader = request.headers.get("Range");
  const upstream = await cdnFetch(segUrl, rangeHeader);

  if (!upstream.ok && upstream.status !== 206) {
    throw new HttpError(upstream.status, "CDN segment fetch failed");
  }

  const headers: Record<string, string> = {
    "Content-Type": upstream.headers.get("Content-Type") || "video/MP2T",
    "Cache-Control": "public, max-age=31536000, immutable",
    ...CORS_HEADERS,
  };

  const cl = upstream.headers.get("Content-Length");
  const cr = upstream.headers.get("Content-Range");
  if (cl) headers["Content-Length"] = cl;
  if (cr) headers["Content-Range"] = cr;

  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function serveEventsJson(workerUrl: URL): Promise<Response> {
  const { events } = await fetchUpstreamPlaylist();
  const base = workerBase(workerUrl);

  const enrichedEvents = events.map((e) => ({
    ...e,
    streamUrl: `${base}/fancode/${e.slug}/playlist.m3u8`,
  }));

  return jsonResponse({
    count: enrichedEvents.length,
    events: enrichedEvents,
    masterPlaylistUrl: `${base}/playlist.m3u8`,
    updatedAt: new Date().toISOString(),
  });
}

// ─── Main Dispatcher ─────────────────────────────────────────────────────────

export const USAGE_DOC = `
PLUGX FC API IS ONLINE
======================

Master playlist:
  GET /playlist.m3u8

Per-event HLS master:
  GET /fancode/<event-id>/playlist.m3u8
  e.g. /fancode/4251136/playlist.m3u8

Variant playlist:
  GET /fancode/<event-id>/1080p.m3u8
  GET /fancode/<event-id>/720p.m3u8

Segment proxy:
  GET /fancode/<event-id>/seg/<encoded>
`.trim();

/**
 * Handles incoming request. Returns Response if matched, or null if unhandled.
 */
export async function handleFanCodeRequest(
  request: Request,
  _env?: unknown,
  _ctx?: unknown,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  // Fast check: does this path belong to the proxy?
  const isProxyPath =
    path === "/playlist.m3u8" ||
    path === "/playlist" ||
    path.startsWith("/fancode/") ||
    path.startsWith("/api/fancode");

  if (!isProxyPath) {
    return null; // Let standard SSR / app router handle it
  }

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (method !== "GET" && method !== "HEAD") {
    return errorResponse(405, "Method Not Allowed");
  }

  try {
    // Master playlist
    if (path === "/playlist.m3u8" || path === "/playlist") {
      return await serveMasterPlaylist(url);
    }

    // JSON API for frontend
    if (path === "/api/fancode/events" || path === "/api/fancode") {
      return await serveEventsJson(url);
    }

    // Per-event HLS master: /fancode/<slug>/playlist.m3u8
    const eventMasterMatch = path.match(/^\/fancode\/([^/]+)\/playlist\.m3u8$/);
    if (eventMasterMatch && eventMasterMatch[1]) {
      return await serveEventMaster(eventMasterMatch[1], url, request);
    }

    // Variant playlist: /fancode/<slug>/<quality>.m3u8
    const variantMatch = path.match(/^\/fancode\/([^/]+)\/([^/]+\.m3u8)$/);
    if (variantMatch && variantMatch[1] && variantMatch[2]) {
      return await serveVariant(variantMatch[1], variantMatch[2], url, request);
    }

    // Segment: /fancode/<slug>/seg/<base64-encoded-segment-path>
    const segMatch = path.match(/^\/fancode\/([^/]+)\/seg\/(.+)$/);
    if (segMatch && segMatch[1] && segMatch[2]) {
      return await serveSegment(segMatch[1], segMatch[2], request);
    }

    return errorResponse(404, "Not found — see /playlist.m3u8 or /api/fancode/events");
  } catch (e) {
    if (e instanceof HttpError) {
      return errorResponse(e.status, e.message);
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error("[FanCode Proxy Error]:", message);
    return errorResponse(502, "Upstream error: " + message);
  }
}
