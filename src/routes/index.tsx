import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useMemo } from "react";
import {
  Play,
  Tv,
  Radio,
  Search,
  Copy,
  Check,
  ExternalLink,
  RefreshCw,
  Info,
  Flame,
  X,
  Code2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export const Route = createFileRoute("/")({
  component: FanCodeDashboard,
});

interface FanCodeEventItem {
  slug: string;
  cdnUrl: string;
  name: string;
  logo?: string;
  category?: string;
  streamUrl?: string;
}

interface EventsApiResponse {
  count: number;
  events: FanCodeEventItem[];
  masterPlaylistUrl: string;
  updatedAt: string;
}

declare global {
  interface Window {
    Hls?: any;
  }
}

function FanCodeDashboard() {
  const [events, setEvents] = useState<FanCodeEventItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<string>("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [activeEvent, setActiveEvent] = useState<FanCodeEventItem | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [masterCopied, setMasterCopied] = useState<boolean>(false);
  const [masterUrl, setMasterUrl] = useState<string>("/playlist.m3u8");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsInstanceRef = useRef<any>(null);
  const playerSectionRef = useRef<HTMLDivElement | null>(null);

  // Load Hls.js script dynamically if not present
  useEffect(() => {
    if (typeof window === "undefined" || window.Hls) return;
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/hls.js@latest";
    script.async = true;
    document.body.appendChild(script);
    return () => {
      if (document.body.contains(script)) {
        document.body.removeChild(script);
      }
    };
  }, []);

  // Fetch events from the proxy API
  const fetchEvents = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fancode/events");
      if (!res.ok) {
        throw new Error(`Failed to load events: HTTP ${res.status}`);
      }
      const data: EventsApiResponse = await res.json();
      setEvents(data.events || []);
      if (data.masterPlaylistUrl) {
        setMasterUrl(data.masterPlaylistUrl);
      }
    } catch (err) {
      console.error("Failed to load FanCode events", err);
      setError(err instanceof Error ? err.message : "Error connecting to FanCode stream proxy.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
    if (typeof window !== "undefined") {
      setMasterUrl(`${window.location.origin}/playlist.m3u8`);
    }
  }, []);

  // Set up video playback whenever activeEvent changes
  useEffect(() => {
    if (!activeEvent || !videoRef.current) return;

    const video = videoRef.current;
    const streamSrc = activeEvent.streamUrl || `/fancode/${activeEvent.slug}/playlist.m3u8`;

    // Destroy existing HLS instance if any
    if (hlsInstanceRef.current) {
      hlsInstanceRef.current.destroy();
      hlsInstanceRef.current = null;
    }

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
      });
      hlsInstanceRef.current = hls;
      hls.loadSource(streamSrc);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {
          // Auto-play was prevented; user interaction needed
        });
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native Safari / iOS HLS
      video.src = streamSrc;
      video.play().catch(() => {});
    }

    return () => {
      if (hlsInstanceRef.current) {
        hlsInstanceRef.current.destroy();
        hlsInstanceRef.current = null;
      }
    };
  }, [activeEvent]);

  // Categories list
  const categories = useMemo(() => {
    const set = new Set<string>();
    events.forEach((e) => {
      if (e.category) set.add(e.category);
    });
    return ["all", ...Array.from(set)];
  }, [events]);

  // Filtered events
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      const matchSearch =
        e.name.toLowerCase().includes(search.toLowerCase()) ||
        e.slug.toLowerCase().includes(search.toLowerCase());
      const matchCat =
        selectedCategory === "all" ||
        (e.category && e.category.toLowerCase() === selectedCategory.toLowerCase());
      return matchSearch && matchCat;
    });
  }, [events, search, selectedCategory]);

  const copyToClipboard = (text: string, isMaster = false, slug?: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      if (isMaster) {
        setMasterCopied(true);
        setTimeout(() => setMasterCopied(false), 2000);
      } else if (slug) {
        setCopiedSlug(slug);
        setTimeout(() => setCopiedSlug(null), 2000);
      }
    }
  };

  const handleSelectEvent = (eventItem: FanCodeEventItem) => {
    setActiveEvent(eventItem);
    setTimeout(() => {
      playerSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 antialiased">
      {/* Top Navigation */}
      <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-amber-500 to-orange-600 shadow-lg shadow-orange-500/20">
              <Flame className="h-6 w-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold tracking-tight text-lg text-white">FanCode Stream Hub</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  LIVE PROXY
                </span>
              </div>
              <p className="text-xs text-slate-400">Clean HLS M3U8 Stream Proxy & Web Player</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => copyToClipboard(masterUrl, true)}
              className="border-slate-700 bg-slate-900/80 text-xs text-slate-200 hover:bg-slate-800 hover:text-white"
            >
              {masterCopied ? (
                <>
                  <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-400" />
                  Copied M3U8
                </>
              ) : (
                <>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Copy Master Playlist
                </>
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={fetchEvents}
              disabled={loading}
              title="Refresh events"
              className="text-slate-400 hover:text-white hover:bg-slate-800"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin text-orange-400" : ""}`} />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 space-y-8">
        {/* Active Player Section */}
        {activeEvent && (
          <div ref={playerSectionRef} className="scroll-mt-20">
            <Card className="overflow-hidden border-slate-800 bg-slate-900 shadow-2xl">
              <div className="relative aspect-video w-full bg-black">
                <video
                  ref={videoRef}
                  controls
                  playsInline
                  className="h-full w-full object-contain"
                  poster={activeEvent.logo}
                />
                <button
                  onClick={() => setActiveEvent(null)}
                  className="absolute right-4 top-4 rounded-full bg-black/60 p-2 text-white/80 backdrop-blur-md transition-colors hover:bg-black hover:text-white"
                  title="Close Player"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <CardContent className="p-4 sm:p-6 space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge className="bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 border-orange-500/30">
                        {activeEvent.category || "Live Stream"}
                      </Badge>
                      <span className="text-xs text-slate-400 font-mono">ID: {activeEvent.slug}</span>
                    </div>
                    <h2 className="text-xl font-bold text-white tracking-tight">{activeEvent.name}</h2>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-slate-700 bg-slate-800 text-xs hover:bg-slate-700"
                      onClick={() =>
                        copyToClipboard(
                          activeEvent.streamUrl || `${window.location.origin}/fancode/${activeEvent.slug}/playlist.m3u8`,
                          false,
                          activeEvent.slug,
                        )
                      }
                    >
                      {copiedSlug === activeEvent.slug ? (
                        <>
                          <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-400" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="mr-1.5 h-3.5 w-3.5" />
                          Copy Stream M3U8
                        </>
                      )}
                    </Button>

                    <a
                      href={activeEvent.streamUrl || `/fancode/${activeEvent.slug}/playlist.m3u8`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open Stream
                    </a>
                  </div>
                </div>

                <div className="rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-400 break-all border border-slate-800 flex items-center justify-between">
                  <span>{activeEvent.streamUrl || `${typeof window !== "undefined" ? window.location.origin : ""}/fancode/${activeEvent.slug}/playlist.m3u8`}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Controls Bar: Search & Category Filter */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              placeholder="Search matches, tournaments, teams..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 border-slate-800 bg-slate-900/90 text-white placeholder:text-slate-500 focus-visible:ring-orange-500"
            />
          </div>

          {categories.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    selectedCategory === cat
                      ? "bg-orange-500 text-white"
                      : "bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-slate-800"
                  }`}
                >
                  {cat === "all" ? "All Sports" : cat}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Status / Error Banner */}
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400 flex items-center gap-3">
            <Info className="h-5 w-5 shrink-0 text-red-400" />
            <div className="flex-1">
              <p className="font-semibold">Unable to fetch streams from upstream proxy</p>
              <p className="text-xs text-red-300 mt-0.5">{error}</p>
            </div>
            <Button size="sm" variant="outline" onClick={fetchEvents} className="border-red-500/30 text-xs">
              Retry
            </Button>
          </div>
        )}

        {/* Events Grid */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Tv className="h-5 w-5 text-orange-400" />
              <h2 className="text-lg font-bold text-white tracking-tight">Available Live Matches</h2>
              <Badge variant="secondary" className="bg-slate-800 text-slate-300">
                {filteredEvents.length}
              </Badge>
            </div>
          </div>

          {loading && events.length === 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div
                  key={i}
                  className="h-44 rounded-xl border border-slate-800 bg-slate-900/60 p-4 animate-pulse space-y-3"
                >
                  <div className="h-4 w-1/3 bg-slate-800 rounded" />
                  <div className="h-6 w-3/4 bg-slate-800 rounded" />
                  <div className="h-4 w-1/2 bg-slate-800 rounded mt-6" />
                </div>
              ))}
            </div>
          ) : filteredEvents.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-800 p-12 text-center">
              <Radio className="mx-auto h-12 w-12 text-slate-600 mb-3" />
              <h3 className="text-base font-semibold text-slate-200">No events found</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                {search ? "No events match your current search query." : "Currently no live matches found from upstream."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredEvents.map((item) => {
                const streamLink = item.streamUrl || `/fancode/${item.slug}/playlist.m3u8`;
                const isPlaying = activeEvent?.slug === item.slug;

                return (
                  <Card
                    key={item.slug}
                    className={`flex flex-col justify-between border-slate-800/80 bg-slate-900/70 transition-all hover:border-slate-700 hover:shadow-lg ${
                      isPlaying ? "ring-2 ring-orange-500" : ""
                    }`}
                  >
                    <CardHeader className="p-4 pb-2">
                      <div className="flex items-start justify-between gap-3">
                        <Badge
                          variant="outline"
                          className="border-slate-700 bg-slate-800/80 text-[10px] text-slate-300 font-mono"
                        >
                          {item.category || "Live Event"}
                        </Badge>
                        <span className="text-[11px] text-slate-500 font-mono">#{item.slug}</span>
                      </div>
                      <CardTitle className="text-base font-semibold text-white leading-snug line-clamp-2 mt-2">
                        {item.name}
                      </CardTitle>
                    </CardHeader>

                    <CardContent className="p-4 pt-2 space-y-3">
                      {item.logo && (
                        <div className="flex items-center gap-2 pt-1">
                          <img
                            src={item.logo}
                            alt=""
                            className="h-6 w-auto max-w-[80px] object-contain opacity-80"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = "none";
                            }}
                          />
                        </div>
                      )}

                      <div className="flex items-center gap-2 pt-2">
                        <Button
                          size="sm"
                          onClick={() => handleSelectEvent(item)}
                          className={`flex-1 text-xs font-semibold ${
                            isPlaying
                              ? "bg-orange-600 hover:bg-orange-700 text-white"
                              : "bg-orange-500 hover:bg-orange-600 text-white shadow-md shadow-orange-500/20"
                          }`}
                        >
                          <Play className="mr-1.5 h-3.5 w-3.5 fill-current" />
                          {isPlaying ? "Playing Now" : "Watch Match"}
                        </Button>

                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => copyToClipboard(streamLink, false, item.slug)}
                          className="border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white px-2.5"
                          title="Copy M3U8 URL"
                        >
                          {copiedSlug === item.slug ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        {/* Documentation & Integration Details */}
        <section className="pt-6">
          <Card className="border-slate-800 bg-slate-900/50">
            <CardHeader className="p-6">
              <div className="flex items-center gap-2">
                <Code2 className="h-5 w-5 text-orange-400" />
                <CardTitle className="text-base font-bold text-white">Proxy Architecture & Endpoints</CardTitle>
              </div>
              <CardDescription className="text-xs text-slate-400">
                Rewrites upstream FanCode streams with CORS headers, proper Referer & Origin injection, and clean slug URLs.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6 pt-0 space-y-4">
              <Tabs defaultValue="endpoints" className="w-full">
                <TabsList className="bg-slate-800/80 border border-slate-700">
                  <TabsTrigger value="endpoints" className="text-xs">API Endpoints</TabsTrigger>
                  <TabsTrigger value="players" className="text-xs">External Players (VLC/IPTV)</TabsTrigger>
                  <TabsTrigger value="worker" className="text-xs">Cloudflare Worker Deploy</TabsTrigger>
                </TabsList>

                <TabsContent value="endpoints" className="space-y-3 pt-4 text-xs font-mono">
                  <div className="rounded-lg bg-slate-950 p-4 border border-slate-800 space-y-2 text-slate-300">
                    <p className="text-slate-400 font-sans font-semibold">Master & Event Routes:</p>
                    <p className="text-emerald-400">GET /playlist.m3u8 <span className="text-slate-500 font-sans">— Master playlist for all events</span></p>
                    <p className="text-emerald-400">GET /fancode/:slug/playlist.m3u8 <span className="text-slate-500 font-sans">— Rewritten HLS master for specific match</span></p>
                    <p className="text-emerald-400">GET /fancode/:slug/:quality.m3u8 <span className="text-slate-500 font-sans">— Variant quality playlist (1080p, 720p)</span></p>
                    <p className="text-emerald-400">GET /fancode/:slug/seg/:encoded <span className="text-slate-500 font-sans">— Proxied video segment (TS/fMP4) with custom headers</span></p>
                    <p className="text-emerald-400">GET /api/fancode/events <span className="text-slate-500 font-sans">— JSON event list for UI integration</span></p>
                  </div>
                </TabsContent>

                <TabsContent value="players" className="space-y-3 pt-4 text-xs text-slate-300">
                  <div className="rounded-lg bg-slate-950 p-4 border border-slate-800 space-y-2">
                    <p className="font-semibold text-white">How to stream in VLC / PotPlayer / OTT Navigator:</p>
                    <ol className="list-decimal pl-5 space-y-1 text-slate-400">
                      <li>Copy the <strong>Master Playlist</strong> URL (<code className="text-orange-400">/playlist.m3u8</code>) or any individual event stream M3U8.</li>
                      <li>In VLC: Open Media &rarr; Open Network Stream &rarr; Paste URL &rarr; Click Play.</li>
                      <li>In IPTV apps (TiviMate, IPTV Smarters, OTT Navigator): Add M3U8 Playlist with the master playlist URL.</li>
                    </ol>
                  </div>
                </TabsContent>

                <TabsContent value="worker" className="space-y-3 pt-4 text-xs text-slate-300">
                  <div className="rounded-lg bg-slate-950 p-4 border border-slate-800 space-y-2 font-mono">
                    <p className="font-sans text-slate-400">To deploy standalone to Cloudflare Workers:</p>
                    <p className="text-amber-400 font-sans">1. Source file: <code className="text-white">src/worker.ts</code></p>
                    <p className="text-amber-400 font-sans">2. Run: <code className="text-white">npx wrangler deploy src/worker.ts --name fancode-proxy</code></p>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}
