import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Hand, CarFront, KeyRound, Tag, Wrench, Navigation, Volume2, Lightbulb } from "lucide-react";
import { Photo } from "@/components/Photo";
import { PICS, Pic } from "@/lib/images";
import { cn } from "@/lib/format";
import { ART } from "./art";
import { GUIDES, Lang } from "./guides";

const GUIDE_ICON = { start: Hand, ride: CarFront, rent: KeyRound, buy: Tag, repair: Wrench, drive: Navigation } as const;
const GUIDE_PIC: Record<string, Pic> = { start: PICS.cityTaxi, ride: PICS.autoRickshaw, rent: PICS.suvRoad, buy: PICS.carLot, repair: PICS.garage, drive: PICS.nightCab };
const LS = "ridex.lang";
const readLang = (): Lang => { try { return localStorage.getItem(LS) === "hi" ? "hi" : "en"; } catch { return "en"; } };

function speak(text: string, lang: Lang) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === "hi" ? "hi-IN" : "en-IN"; u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

export function Help() {
  const [params, setParams] = useSearchParams();
  const [lang, setLang] = useState<Lang>(readLang);
  const open = params.get("guide") ?? "start";
  const guide = GUIDES.find((g) => g.id === open) ?? GUIDES[0];
  useEffect(() => { try { localStorage.setItem(LS, lang); } catch { /* private mode */ } }, [lang]);
  useEffect(() => () => { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); }, []);
  const t = (o: { en: string; hi: string }) => o[lang];

  return (
    <div data-line={guide.line}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1>{lang === "hi" ? "RideX कैसे इस्तेमाल करें" : "How to use RideX"}</h1>
          <p className="mt-1 text-base text-mute">{lang === "hi" ? "तस्वीरें देखें, एक-एक क़दम चलें। स्पीकर बटन दबाकर सुन भी सकते हैं।" : "Look at the pictures and follow one step at a time. Press the speaker button to hear it read out."}</p>
        </div>
        <div role="group" aria-label="Language" className="flex overflow-hidden rounded-xl border border-slate-300 bg-white">
          {(["en", "hi"] as Lang[]).map((l) => (
            <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} className={cn("px-4 py-2 text-base font-bold", lang === l ? "bg-ink text-white" : "bg-white hover:bg-concrete")}>{l === "en" ? "English" : "हिन्दी"}</button>
          ))}
        </div>
      </div>

      <nav aria-label="Guides" className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {GUIDES.map((g) => (
          <button key={g.id} data-line={g.line} onClick={() => setParams({ guide: g.id })} aria-current={g.id === guide.id ? "page" : undefined}
            className={cn("rounded-3xl border px-3 py-3 text-left shadow-card transition", g.id === guide.id ? "border-transparent bg-brand text-white" : "border-white bg-white hover:-translate-y-0.5")}>
            <span className="block" aria-hidden>{(() => { const I = GUIDE_ICON[g.id as keyof typeof GUIDE_ICON]; return <I size={28} />; })()}</span>
            <span className="mt-1 block text-base font-bold leading-tight">{t(g.title)}</span>
          </button>
        ))}
      </nav>

      <section aria-labelledby="guide-title">
        <div aria-hidden className="mb-5"><Photo pic={GUIDE_PIC[guide.id] ?? PICS.cityTaxi} sizes="(min-width:1024px) 1100px, 100vw" className="h-36 rounded-3xl sm:h-48" /></div>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 id="guide-title" className="text-2xl">{t(guide.title)}</h2>
          <button className="btn btn-ghost btn-sm" onClick={() => speak([t(guide.title), t(guide.intro), ...guide.steps.map((s, i) => `${i + 1}. ${t(s)}`)].join(". "), lang)}><Volume2 size={16} aria-hidden />{lang === "hi" ? "पूरा सुनें" : "Read it all aloud"}</button>
        </div>
        <p className="mb-5 max-w-prose text-lg">{t(guide.intro)}</p>
        <ol className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {guide.steps.map((s, i) => {
            const Art = ART[s.art];
            return (
              <li key={i} className="panel">
                <div className="panel-body space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="num flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-xl font-extrabold text-white" aria-hidden>{i + 1}</span>
                    <p className="sr-only">{lang === "hi" ? "क़दम" : "Step"} {i + 1}</p>
                    <button className="ml-auto rounded-full p-2 hover:bg-concrete" aria-label={lang === "hi" ? "यह क़दम सुनें" : "Hear this step"} onClick={() => speak(t(s) + (s.note ? ". " + t(s.note) : ""), lang)}><Volume2 size={22} aria-hidden /></button>
                  </div>
                  {Art && <Art />}
                  <p className="text-lg font-semibold leading-snug">{t(s)}</p>
                  {s.note && <p className="flex gap-2 rounded-xl bg-concrete px-3 py-2 text-base"><Lightbulb size={18} className="mt-1 shrink-0" aria-hidden /><span>{t(s.note)}</span></p>}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <p className="mt-8 border-t border-rule pt-4 text-base text-mute">{lang === "hi" ? "अटक गए? ऊपर बाएँ “Help” दबाकर यह पन्ना कभी भी खोलें।" : "Stuck? Press “Help” on the left menu to open this page any time."}</p>
    </div>
  );
}
