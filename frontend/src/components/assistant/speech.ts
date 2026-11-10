/** Thin wrappers over the browser's Web Speech API. Both halves are optional: Firefox has no recognition, some phones lack a voice for a language. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Lang { code: string; name: string; native: string; speech: string }

export const FALLBACK_LANGS: Lang[] = [
  { code: "en", name: "English", native: "English", speech: "en-IN" },
  { code: "hi", name: "Hindi", native: "हिन्दी", speech: "hi-IN" },
];

export const recognitionCtor = (): any | null => (typeof window === "undefined" ? null : (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null);
export const canListen = () => recognitionCtor() !== null;
export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

/** Best installed voice for a BCP-47 tag: exact match, then same language, else none (the browser will then guess). */
export function pickVoice(tag: string): SpeechSynthesisVoice | undefined {
  if (!canSpeak()) return undefined;
  const voices = window.speechSynthesis.getVoices();
  const base = tag.split("-")[0].toLowerCase();
  return voices.find((v) => v.lang.replace("_", "-").toLowerCase() === tag.toLowerCase()) ?? voices.find((v) => v.lang.toLowerCase().startsWith(base));
}
export const hasVoiceFor = (tag: string) => !canSpeak() || window.speechSynthesis.getVoices().length === 0 || !!pickVoice(tag);

export function speak(text: string, tag: string, onEnd?: () => void) {
  if (!canSpeak()) { onEnd?.(); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = tag; u.rate = 0.9;
  const v = pickVoice(tag); if (v) u.voice = v;
  u.onend = () => onEnd?.(); u.onerror = () => onEnd?.();
  window.speechSynthesis.speak(u);
}
export const stopSpeaking = () => { if (canSpeak()) window.speechSynthesis.cancel(); };

/** Start listening once. Returns a stop function. Errors are mapped to a short code the UI can explain. */
export function listen(tag: string, h: { onInterim: (t: string) => void; onFinal: (t: string) => void; onError: (code: string) => void; onEnd: () => void }) {
  const Ctor = recognitionCtor();
  if (!Ctor) { h.onError("unsupported"); h.onEnd(); return () => undefined; }
  const r = new Ctor();
  r.lang = tag; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
  let finalText = "";
  r.onresult = (e: any) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript as string;
      if (e.results[i].isFinal) finalText += t; else interim += t;
    }
    if (interim) h.onInterim(interim);
  };
  r.onerror = (e: any) => h.onError(String(e.error ?? "error"));
  r.onend = () => { if (finalText.trim()) h.onFinal(finalText.trim()); h.onEnd(); };
  try { r.start(); } catch { h.onError("error"); h.onEnd(); }
  return () => { try { r.stop(); } catch { /* already stopped */ } };
}
