import { create } from "zustand";

export interface Toast { id: number; kind: "ok" | "error"; text: string }
interface ToastState { toasts: Toast[]; push: (kind: Toast["kind"], text: string) => void; dismiss: (id: number) => void }
let n = 0;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(kind, text) {
    const id = ++n;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => get().dismiss(id), kind === "error" ? 7000 : 3500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  ok: (text: string) => useToasts.getState().push("ok", text),
  error: (text: string) => useToasts.getState().push("error", text),
};
