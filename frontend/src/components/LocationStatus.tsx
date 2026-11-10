import { LocateFixed, LocateOff, LoaderCircle } from "lucide-react";
import { LiveStatus } from "@/hooks/useLiveLocation";

/** One honest line about the location permission, with a way to retry. Renders nothing while all is well and quiet. */
export function LocationStatus({ status, error, accuracy, retry, who = "your", quiet }: { status: LiveStatus; error: string; accuracy?: number; retry: () => void; who?: string; /** Say nothing unless something is wrong. */ quiet?: boolean }) {
  if (status === "idle" || (quiet && (status === "live" || status === "asking"))) return null;
  if (status === "asking") return <p role="status" className="flex items-center gap-2 rounded-xl bg-concrete px-3 py-2 text-sm text-mute"><LoaderCircle size={16} className="animate-spin" aria-hidden />Finding {who} location. Tap Allow if your browser asks.</p>;
  if (status === "live") return <p role="status" className="flex items-center gap-2 rounded-xl bg-earn/10 px-3 py-2 text-sm text-earn-ink"><LocateFixed size={16} aria-hidden />Live location is on{accuracy != null && <span className="text-mute"> (accurate to about {Math.max(5, Math.round(accuracy))} m)</span>}</p>;
  return (
    <p role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-repair/10 px-3 py-2 text-sm">
      <LocateOff size={16} aria-hidden /><span className="min-w-0 flex-1">{error}</span>
      <button type="button" className="font-bold underline" onClick={retry}>Try again</button>
    </p>
  );
}
