import { useState } from "react";
import { post } from "@/lib/api";
import { Button, Modal } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { toast } from "@/store/toast";
import { cn } from "@/lib/format";

export function RateRide({ rideId, who, onClose, onRated }: { rideId: string; who: string; onClose: () => void; onRated: () => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    try { await post(`/rides/${rideId}/rate`, { rating, ...(comment.trim() ? { comment: comment.trim() } : {}) }); toast.ok("Thanks for rating"); onRated(); onClose(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Rate ${who}`} onClose={onClose}>
      <div className="space-y-4">
        <div role="radiogroup" aria-label="Rating" className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} onClick={() => setRating(n)}
              className={cn("h-12 w-12 rounded-2xl font-display text-lg font-bold transition", n <= rating ? "bg-brand text-white" : "bg-concrete hover:bg-brand-soft")}>{n}</button>
          ))}
        </div>
        <textarea aria-label="Comment" rows={3} maxLength={500} placeholder="Anything to add? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Not now</Button><Button disabled={!rating} busy={busy} onClick={send}>Send rating</Button></div>
      </div>
    </Modal>
  );
}
