import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { post } from "@/lib/api";
import { dt } from "@/lib/format";
import { Button, Empty, Loading, PageHeader } from "@/components/ui";
import { useAction } from "@/hooks/useApi";

interface Notification { id: string; type: string; title: string; body: string | null; readAt: string | null; createdAt: string }

export function Notifications() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifications"], queryFn: async () => (await get<{ notifications: Notification[] }>("/notifications", { limit: 50 })).notifications });
  const readAll = useAction(() => post("/notifications/read-all"), { invalidate: [["notifications"], ["unread"]] });
  return (
    <div data-line="ride">
      <PageHeader title="Notifications" action={<Button variant="ghost" size="sm" busy={readAll.isPending} onClick={() => readAll.mutate(undefined)}>Mark all as read</Button>} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="You're all caught up">Updates about your rides, bookings and payments will appear here.</Empty> : (
        <ul className="border border-rule bg-white">
          {q.data.map((n) => (
            <li key={n.id} className={`flex gap-3 border-b border-rule px-4 py-3 last:border-b-0 ${n.readAt ? "" : "bg-brand-soft/60"}`}>
              <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${n.readAt ? "bg-rule" : "bg-ink"}`} />
              <div className="min-w-0 flex-1"><p className="font-bold">{n.title}</p>{n.body && <p className="text-sm text-mute">{n.body}</p>}</div>
              <time className="shrink-0 text-xs text-mute">{dt(n.createdAt)}</time>
            </li>
          ))}
        </ul>
      )}
      {void qc}
    </div>
  );
}
