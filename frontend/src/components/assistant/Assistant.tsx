import { Mic, Square } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get, post, errorMessage } from "@/lib/api";
import { cn } from "@/lib/format";
import { useAuth } from "@/store/auth";
import { greeting, suggestionsFor } from "./context";
import { FALLBACK_LANGS, Lang, canListen, hasVoiceFor, listen, speak, stopSpeaking } from "./speech";

const LS_LANG = "ridex.assistant.lang";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

interface Reply { answer: string; language: string; source: "ai" | "guide"; languageFallback: boolean }

const pageOf = (p: string) =>
  p.startsWith("/login") ? "login" : p.startsWith("/guide") || p.startsWith("/help") ? "help" : p.startsWith("/ride") ? "ride" : p.startsWith("/rent") || p.startsWith("/drive/rentals") ? "rent"
  : p.startsWith("/buy") ? "buy" : p.startsWith("/sell") ? "sell" : p.startsWith("/repair") ? "repair" : p.startsWith("/drive/earnings") ? "earnings" : p.startsWith("/drive") ? "drive"
  : p.startsWith("/payments") ? "payments" : p.startsWith("/admin") ? "admin" : "other";

/** Labels: full translations for the two languages the guide ships in; everything else shows English plus the language's own name. */
const T = {
  en: { title: "Ask RideX", tap: "Tap and speak", listening: "Listening… speak now", thinking: "Thinking…", type: "Or type your question", send: "Ask", again: "Hear again", stop: "Stop", close: "Close", lang: "Language", hint: "Try asking:", sug: ["How do I book a ride?", "How do I pay?", "My vehicle broke down"], noMic: "Voice input is not available in this browser. You can type your question instead.", denied: "The microphone is blocked. Allow it in your browser settings, or type your question.", nospeech: "I did not hear anything. Tap the microphone and try again.", noVoice: "This device has no voice for this language, so I will show the answer as text." },
  hi: { title: "RideX से पूछें", tap: "दबाएँ और बोलें", listening: "सुन रहा हूँ… अब बोलिए", thinking: "सोच रहा हूँ…", type: "या अपना सवाल लिखें", send: "पूछें", again: "फिर सुनें", stop: "रोकें", close: "बंद करें", lang: "भाषा", hint: "जैसे पूछें:", sug: ["सवारी कैसे बुक करूँ?", "भुगतान कैसे करूँ?", "मेरी गाड़ी ख़राब हो गई"], noMic: "इस ब्राउज़र में बोलकर पूछना नहीं चलता। आप सवाल लिख सकते हैं।", denied: "माइक बंद है। ब्राउज़र की सेटिंग में माइक की अनुमति दें, या सवाल लिखें।", nospeech: "कुछ सुनाई नहीं दिया। माइक दबाकर फिर बोलिए।", noVoice: "इस फ़ोन में इस भाषा की आवाज़ नहीं है, इसलिए जवाब लिखकर दिखाऊँगा।" },
} as const;

export function Assistant() {
  const loc = useLocation();
  const langs = useQuery({ queryKey: ["assistant-langs"], staleTime: Infinity, retry: 1, queryFn: () => get<{ languages: Lang[]; aiEnabled: boolean }>("/assistant/languages") });
  const list = langs.data?.languages ?? FALLBACK_LANGS;
  const user = useAuth((st) => st.user);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(() => read(LS_LANG) ?? read("ridex.lang") ?? "en");
  const lang = list.find((l) => l.code === code) ?? list[0];
  const t = T[code === "hi" ? "hi" : "en"];
  const [phase, setPhase] = useState<"idle" | "listening" | "thinking">("idle");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const stopRef = useRef<() => void>(() => undefined);

  useEffect(() => { write(LS_LANG, code); }, [code]);
  // Screens with their own layout (the full-screen map) open the assistant from a button in their header.
  useEffect(() => { const on = () => setOpen(true); window.addEventListener("ridex:assistant", on); return () => window.removeEventListener("ridex:assistant", on); }, []);
  useEffect(() => { if (!open) { stopRef.current(); stopSpeaking(); setPhase("idle"); setSpeaking(false); } }, [open]);
  useEffect(() => () => { stopRef.current(); stopSpeaking(); }, []);

  async function ask(question: string) {
    setHeard(question); setReply(null); setNote(""); setPhase("thinking");
    try {
      const r = await post<Reply>("/assistant/ask", { question, language: lang.code, page: pageOf(loc.pathname) });
      setReply(r); setPhase("idle");
      const tag = list.find((l) => l.code === r.language)?.speech ?? lang.speech;
      if (!hasVoiceFor(tag)) setNote(t.noVoice);
      else { setSpeaking(true); speak(r.answer, tag, () => setSpeaking(false)); }
    } catch (e) { setPhase("idle"); setNote(errorMessage(e)); }
  }

  function startListening() {
    stopSpeaking(); setSpeaking(false); setNote(""); setHeard(""); setReply(null);
    if (!canListen()) { setNote(t.noMic); return; }
    setPhase("listening");
    let got = false;
    stopRef.current = listen(lang.speech, {
      onInterim: setHeard,
      onFinal: (text) => { got = true; void ask(text); },
      onError: (c) => setNote(c === "not-allowed" || c === "service-not-allowed" ? t.denied : c === "unsupported" ? t.noMic : c === "no-speech" ? t.nospeech : t.nospeech),
      onEnd: () => setPhase((p) => (p === "listening" ? "idle" : p)) ,
    });
    void got;
  }

  const submit = (e: FormEvent) => { e.preventDefault(); const q = typed.trim(); if (q) { setTyped(""); void ask(q); } };
  const busy = phase !== "idle";

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label={t.title} aria-haspopup="dialog"
        className={cn("fixed right-4 z-[1900] flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-lift hover:bg-brand-600 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-ink md:bottom-5 md:right-5 md:h-16 md:w-16", loc.pathname === "/ride" ? "hidden md:flex md:bottom-5" : "bottom-24")}>
        <Mic size={26} aria-hidden />
      </button>

      {open && (
        <div role="dialog" aria-modal="true" aria-label={t.title} className="fixed inset-0 z-[2100] flex items-end justify-center bg-ink/50 sm:items-center" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-concrete shadow-lift sm:max-w-lg sm:rounded-3xl" data-line="ride">
            <div className="flex items-center justify-between bg-brand px-5 py-3.5 text-white">
              <h2 className="text-xl">{t.title}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>{t.close}</button>
            </div>
            <div className="space-y-4 p-4">
              <label className="block text-sm font-bold" htmlFor="assistant-lang">{t.lang}
                <select id="assistant-lang" className="mt-1" value={code} onChange={(e) => { setCode(e.target.value); setReply(null); setHeard(""); setNote(""); stopSpeaking(); setSpeaking(false); }}>
                  {list.map((l) => <option key={l.code} value={l.code}>{l.native}{l.native !== l.name ? ` · ${l.name}` : ""}</option>)}
                </select>
              </label>

              <div className="flex flex-col items-center gap-2">
                <button onClick={phase === "listening" ? () => stopRef.current() : startListening} disabled={phase === "thinking"} aria-pressed={phase === "listening"}
                  className={cn("flex h-28 w-28 items-center justify-center rounded-full text-5xl shadow-lift transition", phase === "listening" ? "animate-pulse bg-repair text-white" : "bg-brand text-white hover:bg-brand-600")}>
                  <span aria-hidden className="inline-flex">{phase === "listening" ? <Square size={40} aria-hidden /> : <Mic size={46} aria-hidden />}</span>
                  <span className="sr-only">{phase === "listening" ? t.stop : t.tap}</span>
                </button>
                <p className="text-lg font-bold" aria-live="polite">{phase === "listening" ? t.listening : phase === "thinking" ? t.thinking : t.tap}</p>
              </div>

              {heard && <p className="rounded-xl bg-white px-3 py-2 text-lg"><span className="sr-only">You said: </span>“{heard}”</p>}
              {note && <p role="status" className="rounded-xl bg-repair/10 px-3 py-2">{note}</p>}

              {reply && (
                <div className="rounded-2xl bg-white p-4 shadow-card" aria-live="polite">
                  <p className="text-xl font-semibold leading-snug">{reply.answer}</p>
                  {reply.languageFallback && <p className="mt-2 text-sm text-mute">{t === T.hi ? "इस भाषा में जवाब अभी उपलब्ध नहीं, इसलिए हिन्दी/अंग्रेज़ी में दिया।" : "Answers in this language are not available right now, so I answered in English."}</p>}
                  <div className="mt-3 flex gap-2">
                    <button className="btn btn-ink btn-sm" onClick={() => { if (speaking) { stopSpeaking(); setSpeaking(false); } else { const tag = list.find((l) => l.code === reply.language)?.speech ?? lang.speech; setSpeaking(true); speak(reply.answer, tag, () => setSpeaking(false)); } }}>
                      {speaking ? t.stop : t.again}
                    </button>
                  </div>
                </div>
              )}

              {!heard && !reply && (
                <div className="space-y-3">
                  <p className="rounded-xl bg-white px-3 py-2 text-sm text-mute">{greeting({ signedIn: !!user, first: user?.fullName?.split(" ")[0], roles: user?.roles ?? [], hi: code === "hi" })}</p>
                  {(code === "en" || code === "hi") && (<div><p className="mb-2 text-sm font-bold">{t.hint}</p>
                    <div className="flex flex-wrap gap-2">{suggestionsFor({ signedIn: !!user, roles: user?.roles ?? [], page: pageOf(loc.pathname), hi: code === "hi" }).map((q) => <button key={q} className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void ask(q)}>{q}</button>)}</div></div>)}
                </div>
              )}

              <form onSubmit={submit} className="flex gap-2">
                <input aria-label={t.type} placeholder={t.type} value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={500} lang={lang.speech} />
                <button className="btn btn-primary" disabled={busy || !typed.trim()}>{t.send}</button>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
