import { FormEvent, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, X } from "lucide-react";
import { get, post } from "@/lib/api";
import { connectSocket } from "@/lib/socket";
import { useAuth } from "@/store/auth";
import { useAction } from "@/hooks/useApi";
import { cn } from "@/lib/format";

interface Msg { id: string; senderId: string; body: string; createdAt: string }

/** Short replies as one tap, for people who would rather not type. */
const QUICK = ["I'm at the pickup point", "Please wait 2 minutes", "Where are you now?", "Thank you"];

/** Chat with the other person on this ride (uses the ride's chat API; new messages arrive live over the socket). */
export function RideChat({ rideId, otherName, onClose }: { rideId: string; otherName: string; onClose: () => void }) {
  const me = useAuth((s) => s.user?.id);
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ["chat", rideId], queryFn: async () => (await get<{ messages: Msg[] }>(`/chat/rides/${rideId}/messages`, { limit: 50 })).messages, refetchInterval: 15_000 });
  const send = useAction((body: string) => post(`/chat/rides/${rideId}/messages`, { body }), { invalidate: [["chat", rideId]] });
  const messages = [...(q.data ?? [])].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));

  useEffect(() => {
    const s = connectSocket();
    const on = (m: { rideId?: string }) => { if (!m.rideId || m.rideId === rideId) qc.invalidateQueries({ queryKey: ["chat", rideId] }); };
    s.on("chat:message", on);
    return () => { s.off("chat:message", on); };
  }, [rideId, qc]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [messages.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (e: FormEvent) => { e.preventDefault(); const b = text.trim(); if (!b) return; setText(""); send.mutate(b); };
  const initial = otherName.trim()[0]?.toUpperCase() ?? "?";

  return (
    <div role="dialog" aria-modal="true" aria-label={`Chat with ${otherName}`} className="fixed inset-0 z-[2100] flex items-end justify-center bg-ink/50 md:items-center md:p-4" onMouseDown={onClose}>
      <div className="flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-5xl bg-white shadow-lift md:rounded-4xl" onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-rule px-5 py-4">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand font-bold text-white" aria-hidden>{initial}</span>
          <div className="min-w-0 flex-1"><p className="truncate font-display text-lg font-extrabold">{otherName}</p><p className="text-xs text-mute">About this ride only</p></div>
          <button onClick={onClose} className="rounded-full bg-concrete p-2.5" aria-label="Close chat"><X size={18} /></button>
        </header>
        <div className="min-h-[220px] flex-1 space-y-2 overflow-y-auto bg-concrete/60 px-4 py-4" aria-live="polite">
          {q.isLoading ? <p className="text-center text-sm text-mute">Loading…</p> : !messages.length ? <p className="py-10 text-center text-sm text-mute">No messages yet. Say hello, or tap a quick reply below.</p> : messages.map((m) => {
            const mine = m.senderId === me;
            return (
              <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                <p className={cn("max-w-[80%] rounded-3xl px-4 py-2.5 text-[15px] font-medium", mine ? "rounded-br-lg bg-brand text-white" : "rounded-bl-lg bg-white shadow-card")}>{m.body}</p>
              </div>
            );
          })}
          <div ref={end} />
        </div>
        <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pt-3">
          {QUICK.map((t) => <button key={t} type="button" className="chip !min-h-[38px] shrink-0 !shadow-none !bg-brand-soft !text-brand" onClick={() => send.mutate(t)}>{t}</button>)}
        </div>
        <form onSubmit={submit} className="flex gap-2 p-4">
          <input aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="Type a message" />
          <button className="btn btn-primary !px-5" disabled={!text.trim() || send.isPending} aria-label="Send message"><Send size={18} aria-hidden /></button>
        </form>
      </div>
    </div>
  );
}
