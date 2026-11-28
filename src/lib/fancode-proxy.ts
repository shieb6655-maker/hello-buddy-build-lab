/**
 * FanCode Stream Proxy — TypeScript Implementation
 * Clean URL routing: /fancode/<event-slug>/playlist.m3u8
 */

export interface FanCodeEvent {
  slug: string;
  cdnUrl: string;
  name: string;
  logo: string;
  streamUrl?: string;
  category?: string;
  /** Per-event upstream headers parsed from the "|User-Agent=…&Referer=…" suffix */
  upstreamHeaders?: Record<string, string>;
}

export const UPSTREAM_PLAYLIST = "https://premiumplugx.top/fcd/playlist.php";

/** FanCode serves HLS from several CDN sub-domains (vod, plive, …). */
export const FANCODE_CDN_SUFFIX = ".fancode.com";

/**
 * Default upstream headers used for CDN requests.
 * The UA/Referer values match what the premiumplugx playlist advertises,
 * so the CDN accepts our requests even when no per-event headers are present.
 */
export const FANCODE_HEADERS: Record<string, string> = {
  Referer: "https://fancode.com/",
  Origin: "https://fancode.com",
  "User-Agent":
    "ReactNativeVideo/9.11.1 (Linux;Android 13) AndroidXMedia3/1.6.1",
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
    u.hash = "";
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

/** Safety check: only allow FanCode CDN hosts to be proxied. */
export function isFanCodeHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "fancode.com" || host.endsWith(FANCODE_CDN_SUFFIX);
  } catch {
    return false;
  }
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

/**
 * FIX: The upstream playlist wraps each stream URL with a pipe suffix like:
 *
 *   https://…/index.m3u8|User-Agent=ReactNativeVideo/9.11.1 (Linux;Android 13) AndroidXMedia3/1.6.1&Referer=https://fancode.com/
 *
 * The old code assigned this whole string to `cdnUrl`, so every CDN fetch
 * used a URL containing "|User-Agent=…" and failed. We now split on the pipe,
 * keep the clean URL, and extract the headers separately.
 */
export function parseStreamLine(rawLine: string): { cdnUrl: string; headers: Record<string, string> } {
  const line = rawLine.trim();
  const pipe = line.indexOf("|");
  if (pipe < 0) return { cdnUrl: line, headers: {} };

  const cdnUrl = line.slice(0, pipe).trim();
  const headerStr = line.slice(pipe + 1);
  const headers: Record<string, string> = {};

  // Headers are "Key=Value" separated by '&'. Values may themselves contain '&'
  // (e.g. URLs inside Referer), so only split on '&' that is followed by "Name=".
  const parts = headerStr.split(/&(?=[A-Za-z][A-Za-z0-9-]*=)/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1);
      if (key) headers[key] = value;
    }
  }
  return { cdnUrl, headers };
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
      const { cdnUrl, headers } = parseStreamLine(line);
      const slug = urlToSlug(cdnUrl);
      events.push({
        slug,
        cdnUrl,
        name: lastName || `FanCode Event ${slug}`,
        logo: lastLogo,
        category: lastCategory || "Sports",
        upstreamHeaders: headers,
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
    // @ts-expect-error CF specific fetch option
    cf: { cacheTtl: 60, cacheEverything: true },
  });

  if (!res.ok) {
    if (cachedPlaylist) {
      return { text: cachedPlaylist.text, events: cachedPlaylist.events };
    }
    throw new HttpError(502, `Upstream playlist HTTP ${res.status}`);
  }

  const text = await res.text();
  const events = parsePlaylistEvents(text);
  cachedPlaylist = { text, events, timestamp: now };
  return { text, events };
}

export async function resolveEvent(slug: string): Promise<FanCodeEvent> {
  const { events } = await fetchUpstreamPlaylist();
  const entry = events.find((e) => e.slug === slug);
  if (!entry) throw new HttpError(404, `Event slug not found: ${slug}`);
  return entry;
}

export async function resolveCdnUrl(slug: string): Promise<string> {
  return (await resolveEvent(slug)).cdnUrl;
}

export async function cdnFetch(
  url: string,
  opts: { method?: string; range?: string | null; extraHeaders?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...FANCODE_HEADERS, ...(opts.extraHeaders || {}) };
  if (opts.range) headers["Range"] = opts.range;
  return fetchWithRetry(url, {
    method: opts.method || "GET",
    headers,
    // @ts-expect-error CF specific option
    cf: { cacheTtl: 0 },
  });
}

// ─── Manifest Rewriter ───────────────────────────────────────────────────────

/**
 * FIX: Previous code only rewrote `#EXT-X-KEY`, `#EXT-X-MEDIA` and
 * `#EXT-X(STREAM|I-FRAME-STREAM)-INF`. That meant LL-HLS and fMP4
 * streams broke because `#EXT-X-MAP`, `#EXT-X-PART`,
 * `#EXT-X-PRELOAD-HINT`, `#EXT-X-SESSION-KEY` and
 * `#EXT-X-RENDITION-REPORT` still pointed at the CDN directly.
 *
 * FIX: Variant playlists used to be flattened to their filename. That lost
 * query strings and broke relative sub-directory layouts. They are now
 * encoded as base64 (`/fancode/<slug>/v/<b64>.m3u8`), same idea as segments.
 */
export function rewriteManifest(
  text: string,
  baseUrl: string,
  workerBaseUrl: string,
  slug: string,
  _type: "master" | "variant",
): string {
  const lines = text.split("\n");
  const out: string[] = [];

  const segProxy = (abs: string) =>
    `${workerBaseUrl}/fancode/${slug}/seg/${b64e(abs)}`;
  const varProxy = (abs: string) =>
    `${workerBaseUrl}/fancode/${slug}/v/${b64e(abs)}.m3u8`;

  const SEG_TAGS = [
    "#EXT-X-KEY",
    "#EXT-X-SESSION-KEY",
    "#EXT-X-MAP",
    "#EXT-X-PART",
    "#EXT-X-PRELOAD-HINT",
  ];
  const VAR_TAGS = [
    "#EXT-X-MEDIA",
    "#EXT-X-I-FRAME-STREAM-INF",
    "#EXT-X-RENDITION-REPORT",
  ];

  for (const raw of lines) {
    const line = raw.trimEnd();

    const isSegTag = SEG_TAGS.some((t) => line.startsWith(t) && line.includes('URI="'));
    const isVarTag = VAR_TAGS.some((t) => line.startsWith(t) && line.includes('URI="'));
    const isStreamInfUri = line.startsWith("#EXT-X-STREAM-INF") && line.includes('URI="');

    if (isSegTag || isVarTag || isStreamInfUri) {
      out.push(
        line.replace(/URI="([^"]+)"/, (_, uri: string) => {
          const abs = resolveUrl(uri, baseUrl);
          return `URI="${isSegTag ? segProxy(abs) : varProxy(abs)}"`;
        }),
      );
      continue;
    }

    // Non-comment URI line (variant playlist reference for STREAM-INF,
    // or a bare segment reference inside a media playlist).
    if (!line.startsWith("#") && line.trim() !== "") {
      const abs = resolveUrl(line.trim(), baseUrl);
      const isPlaylist = /\.m3u8(?:$|[?#])/i.test(abs);
      out.push(isPlaylist ? varProxy(abs) : segProxy(abs));
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
      const { cdnUrl } = parseStreamLine(line);
      const slug = urlToSlug(cdnUrl);
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

  // FIX: flush a dangling EXTINF so the last entry isn't dropped.
  if (pendingExtinf) out.push(pendingExtinf);

  return new Response(out.join("\n"), {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

export async function serveEventMaster(slug: string, workerUrl: URL, request: Request): Promise<Response> {
  const event = await resolveEvent(slug);

  // FIX: master playlists are text — no point forwarding Range.
  const upstream = await cdnFetch(event.cdnUrl, {
    method: "GET",
    extraHeaders: event.upstreamHeaders,
  });

  if (!upstream.ok && upstream.status !== 206) {
    throw new HttpError(upstream.status, "CDN master fetch failed");
  }

  const text = await upstream.text();
  const base = workerBase(workerUrl);
  const baseUrl = resolveBase(event.cdnUrl);
  const rewritten = rewriteManifest(text, baseUrl, base, slug, "master");

  const headers = {
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": "no-store",
    ...CORS_HEADERS,
  };

  // FIX: always 200 for rewritten text (Content-Length differs from upstream).
  // FIX: HEAD requests must not carry a body.
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(rewritten, { status: 200, headers });
}

export async function serveVariant(slug: string, encoded: string, request: Request): Promise<Response> {
  // FIX: variant URLs are base64-encoded, preserving query strings and
  // nested sub-directory layouts.
  let cdnUrl: string;
  try {
    cdnUrl = b64d(encoded);
  } catch {
    throw new HttpError(400, "Malformed variant path encoding");
  }

  if (!isFanCodeHost(cdnUrl)) {
    throw new HttpError(403, "Variant not from fancode CDN");
  }

  const upstream = await cdnFetch(cdnUrl, { method: "GET" });
  if (!upstream.ok && upstream.status !== 206) {
    throw new HttpError(upstream.status, "CDN variant fetch failed");
  }

  const text = await upstream.text();
  const base = workerBase(new URL(request.url));
  const baseUrl = resolveBase(cdnUrl);
  const rewritten = rewriteManifest(text, baseUrl, base, slug, "variant");

  const headers = {
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": "no-store",
    ...CORS_HEADERS,
  };

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(rewritten, { status: 200, headers });
}

export async function serveSegment(_slug: string, encodedSeg: string, request: Request): Promise<Response> {
  let segUrl: string;
  try {
    segUrl = b64d(encodedSeg);
  } catch {
    throw new HttpError(400, "Malformed segment path encoding");
  }

  // FIX: the previous check pinned the host to "in-mc-plive.fancode.com",
  // which rejected all in-mc-vod.fancode.com segments. We now accept any
  // *.fancode.com sub-domain.
  if (!isFanCodeHost(segUrl)) {
    throw new HttpError(403, "Segment not from fancode CDN");
  }

  // FIX: forward HEAD as HEAD so Content-Length reflects the actual asset.
  const upstream = await cdnFetch(segUrl, {
    method: request.method,
    range: request.headers.get("Range"),
  });

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
  const ar = upstream.headers.get("Accept-Ranges");
  if (cl) headers["Content-Length"] = cl;
  if (cr) headers["Content-Range"] = cr;
  if (ar) headers["Accept-Ranges"] = ar;

  // For HEAD we still pass the body through — the CF runtime drops it when
  // the client sent HEAD, and the Content-Length header was already copied.
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function serveEventsJson(workerUrl: URL): Promise<Response> {
  const { events } = await fetchUpstreamPlaylist();
  const base = workerBase(workerUrl);

  const enrichedEvents = events.map((e) => ({
    slug: e.slug,
    name: e.name,
    logo: e.logo,
    category: e.category,
    cdnUrl: e.cdnUrl,
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

Variant playlist (base64-encoded CDN path, .m3u8 suffix for MIME hint):
  GET /fancode/<event-id>/v/<base64>.m3u8

Segment proxy:
  GET /fancode/<event-id>/seg/<base64>
`.trim();

export async function handleFanCodeRequest(
  request: Request,
  _env?: unknown,
  _ctx?: unknown,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  const isProxyPath =
    path === "/playlist.m3u8" ||
    path === "/playlist" ||
    path.startsWith("/fancode/") ||
    path.startsWith("/api/fancode");

  if (!isProxyPath) return null;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (method !== "GET" && method !== "HEAD") {
    return errorResponse(405, "Method Not Allowed");
  }

  try {
    if (path === "/playlist.m3u8" || path === "/playlist") {
      return await serveMasterPlaylist(url);
    }

    if (path === "/api/fancode/events" || path === "/api/fancode") {
      return await serveEventsJson(url);
    }

    const eventMasterMatch = path.match(/^\/fancode\/([^/]+)\/playlist\.m3u8$/);
    if (eventMasterMatch && eventMasterMatch[1]) {
      return await serveEventMaster(eventMasterMatch[1], url, request);
    }

    // Variant: /fancode/<slug>/v/<b64>.m3u8
    const variantMatch = path.match(/^\/fancode\/([^/]+)\/v\/(.+)\.m3u8$/);
    if (variantMatch && variantMatch[1] && variantMatch[2]) {
      return await serveVariant(variantMatch[1], variantMatch[2], request);
    }

    // Segment: /fancode/<slug>/seg/<b64>
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
