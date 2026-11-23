import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-center font-mono text-slate-100 antialiased">
      <div className="space-y-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          ONLINE
        </div>
        <h1 className="text-2xl font-bold tracking-wider text-white sm:text-4xl">
          PLUGX FC API IS ONLINE
        </h1>
        <p className="text-xs text-slate-500">
          Master Playlist:{" "}
          <a
            href="/playlist.m3u8"
            className="text-orange-400 underline hover:text-orange-300"
          >
            /playlist.m3u8
          </a>
        </p>
      </div>
    </div>
  );
}
