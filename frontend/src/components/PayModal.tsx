import { useMemo, useState } from "react";
import { post } from "@/lib/api";
import { newKey, inr } from "@/lib/format";
import { Modal, Button, Field } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import { toast } from "@/store/toast";

export type PayableType = "RIDE" | "RENTAL" | "MARKETPLACE" | "GARAGE_SERVICE";

const TOKENS = [
  { id: "tok_mock_success", label: "Test card (succeeds)" },
  { id: "tok_mock_decline", label: "Test card (is declined)" },
  { id: "tok_mock_funds", label: "Test card (insufficient funds)" },
  { id: "tok_mock_error", label: "Test card (gateway error)" },
];

/**
 * Pays for something. The amount is shown for information only: the server works out what is owed and the request
 * carries no amount at all. The idempotency key is created once when the dialog opens, so a double-click or a retry
 * after a timeout can never charge twice.
 */
export function PayModal({ type, id, amount, title, onClose, onPaid }: { type: PayableType; id: string; amount?: number; title: string; onClose: () => void; onPaid: () => void }) {
  const key = useMemo(newKey, []);
  const [token, setToken] = useState(TOKENS[0].id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function pay() {
    setBusy(true); setErr("");
    try {
      await post("/payments", { payableType: type, payableId: id, paymentMethodToken: token }, { "Idempotency-Key": key });
      toast.ok("Payment received");
      onPaid();
      onClose();
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        {amount !== undefined && <p className="num font-display text-3xl font-bold">{inr(amount)}</p>}
        <p className="text-sm text-mute">RideX never sees card numbers. In this demo, choose a test card to see how each outcome behaves.</p>
        <Field label="Payment method">
          {(fid) => <select id={fid} value={token} onChange={(e) => setToken(e.target.value)}>{TOKENS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>}
        </Field>
        {err && <p role="alert" className="rounded-2xl bg-repair/10 px-4 py-3 font-semibold text-sm">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button busy={busy} onClick={pay}>{err ? "Try again" : "Pay now"}</Button>
        </div>
      </div>
    </Modal>
  );
}
