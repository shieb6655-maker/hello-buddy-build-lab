import { describe, expect, it } from "vitest";
import {
  b64e,
  b64d,
  urlToSlug,
  parsePlaylistEvents,
  rewriteManifest,
  handleFanCodeRequest,
} from "../lib/fancode-proxy";

describe("FanCode Stream Proxy Tests", () => {
  it("encodes and decodes base64 reliably", () => {
    const original = "https://in-mc-plive.fancode.com/live/1080p/segment123.ts?token=abc";
    const encoded = b64e(original);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");

    const decoded = b64d(encoded);
    expect(decoded).toBe(original);
  });

  it("extracts numeric event ID or falls back to stable slug", () => {
    const url1 = "https://in-mc-plive.fancode.com/mumbai/4251136_english_hls_xxx/1080p.m3u8";
    expect(urlToSlug(url1)).toBe("4251136");

    const url2 = "https://example.com/custom/stream.m3u8";
    const slug2 = urlToSlug(url2);
    expect(slug2).toBeTruthy();
    expect(slug2.length).toBeLessThanOrEqual(32);
  });

  it("parses EXTINF tags and stream URLs from playlist M3U8", () => {
    const sampleM3u = `
#EXTM3U
#EXTINF:-1 tvg-logo="https://fancode.com/logo1.png" group-title="Cricket",India vs Australia
https://in-mc-plive.fancode.com/mumbai/4251136_english_hls_xxx/master.m3u8
#EXTINF:-1 tvg-logo="https://fancode.com/logo2.png" group-title="Football",Chelsea vs Arsenal
https://in-mc-plive.fancode.com/mumbai/5551234_english_hls_yyy/master.m3u8
    `.trim();

    const events = parsePlaylistEvents(sampleM3u);
    expect(events).toHaveLength(2);

    expect(events[0]?.slug).toBe("4251136");
    expect(events[0]?.name).toBe("India vs Australia");
    expect(events[0]?.logo).toBe("https://fancode.com/logo1.png");
    expect(events[0]?.category).toBe("Cricket");

    expect(events[1]?.slug).toBe("5551234");
    expect(events[1]?.name).toBe("Chelsea vs Arsenal");
    expect(events[1]?.category).toBe("Football");
  });

  it("rewrites master manifest variants and key URIs to route through worker", () => {
    const masterManifest = `
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2149280,RESOLUTION=1280x720
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p.m3u8
    `.trim();

    const rewritten = rewriteManifest(
      masterManifest,
      "https://in-mc-plive.fancode.com/mumbai/4251136_english_hls_xxx/",
      "https://proxy.example.com",
      "4251136",
      "master",
    );

    expect(rewritten).toContain("https://proxy.example.com/fancode/4251136/720p.m3u8");
    expect(rewritten).toContain("https://proxy.example.com/fancode/4251136/1080p.m3u8");
  });

  it("rewrites variant manifest segments to encoded seg URLs", () => {
    const variantManifest = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.000,
segment_0.ts
#EXTINF:6.000,
segment_1.ts
    `.trim();

    const rewritten = rewriteManifest(
      variantManifest,
      "https://in-mc-plive.fancode.com/mumbai/4251136_english_hls_xxx/",
      "https://proxy.example.com",
      "4251136",
      "variant",
    );

    expect(rewritten).toContain("https://proxy.example.com/fancode/4251136/seg/");
    expect(rewritten).not.toContain("segment_0.ts\n");
  });

  it("handles OPTIONS request with CORS headers", async () => {
    const req = new Request("https://proxy.example.com/fancode/4251136/playlist.m3u8", {
      method: "OPTIONS",
    });

    const res = await handleFanCodeRequest(req);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(204);
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns null for non-proxy paths so SSR can handle them", async () => {
    const req = new Request("https://proxy.example.com/", {
      method: "GET",
    });

    const res = await handleFanCodeRequest(req);
    expect(res).toBeNull();
  });
});
