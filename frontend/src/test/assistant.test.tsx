import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { api } from "@/lib/api";
import { Assistant } from "@/components/assistant/Assistant";

const spoken: Array<{ text: string; lang: string }> = [];
class FakeUtterance { text: string; lang = ""; rate = 1; voice: unknown; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(t: string) { this.text = t; } }
let recogInstances: Array<{ lang: string; start: () => void; stop: () => void; onresult: (e: unknown) => void; onend: () => void; onerror: (e: unknown) => void }> = [];

function setup(withMic = true) {
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { cancel: vi.fn(), getVoices: () => [{ lang: "hi-IN" }, { lang: "en-IN" }], speak: (u: FakeUtterance) => { spoken.push({ text: u.text, lang: u.lang }); u.onend?.(); } } });
  (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance = FakeUtterance;
  recogInstances = [];
  if (withMic) (window as unknown as Record<string, unknown>).webkitSpeechRecognition = function (this: Record<string, unknown>) { this.start = () => undefined; this.stop = () => (this.onend as () => void)(); recogInstances.push(this as never); };
  else delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  const mock = new MockAdapter(api); new MockAdapter(axios);
  mock.onGet("/assistant/languages").reply(200, { success: true, data: { aiEnabled: false, languages: [{ code: "en", name: "English", native: "English", speech: "en-IN" }, { code: "hi", name: "Hindi", native: "हिन्दी", speech: "hi-IN" }, { code: "ta", name: "Tamil", native: "தமிழ்", speech: "ta-IN" }] } });
  return mock;
}
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={["/ride"]}><Assistant /></MemoryRouter></QueryClientProvider>);
const say = (text: string) => { const r = recogInstances[0]; r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); r.onend(); };

describe("voice assistant", () => {
  beforeEach(() => { spoken.length = 0; localStorage.clear(); });
  afterEach(() => vi.restoreAllMocks());

  it("listens in the chosen language, asks the server with the page, and reads the answer aloud in that language", async () => {
    const mock = setup();
    mock.onPost("/assistant/ask").reply(200, { success: true, data: { answer: "Ride खोलें।", language: "hi", source: "guide", languageFallback: false } });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Ask RideX" }));
    await userEvent.selectOptions(await screen.findByLabelText("Language"), "hi");
    await userEvent.click(screen.getByRole("button", { name: /Tap and speak|दबाएँ और बोलें/ }));
    expect(recogInstances[0].lang).toBe("hi-IN");
    say("सवारी कैसे बुक करूँ");
    await waitFor(() => expect(screen.getByText("Ride खोलें।")).toBeInTheDocument());
    expect(JSON.parse(mock.history.post[0].data)).toEqual({ question: "सवारी कैसे बुक करूँ", language: "hi", page: "ride" });
    expect(spoken).toEqual([{ text: "Ride खोलें।", lang: "hi-IN" }]);
  });

  it("remembers the language", async () => {
    setup(); mount();
    await userEvent.click(screen.getByRole("button", { name: "Ask RideX" }));
    await userEvent.selectOptions(await screen.findByLabelText("Language"), "ta");
    expect(localStorage.getItem("ridex.assistant.lang")).toBe("ta");
  });

  it("works by typing when the browser has no voice input", async () => {
    const mock = setup(false);
    mock.onPost("/assistant/ask").reply(200, { success: true, data: { answer: "Press Pay.", language: "en", source: "guide", languageFallback: false } });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Ask RideX" }));
    await userEvent.click(screen.getByRole("button", { name: /Tap and speak/ }));
    expect(screen.getByText(/Voice input is not available/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Or type your question"), "how to pay");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(screen.getByText("Press Pay.")).toBeInTheDocument());
  });

  it("says so, and shows text, when the device has no voice for the language", async () => {
    const mock = setup();
    mock.onPost("/assistant/ask").reply(200, { success: true, data: { answer: "பதில்", language: "ta", source: "ai", languageFallback: false } });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Ask RideX" }));
    await userEvent.selectOptions(await screen.findByLabelText("Language"), "ta");
    await userEvent.type(screen.getByLabelText("Or type your question"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(screen.getByText("பதில்")).toBeInTheDocument());
    expect(screen.getByText(/no voice for this language/)).toBeInTheDocument();
    expect(spoken).toHaveLength(0);
  });

  it("explains a blocked microphone in plain words", async () => {
    setup(); mount();
    await userEvent.click(screen.getByRole("button", { name: "Ask RideX" }));
    await userEvent.click(screen.getByRole("button", { name: /Tap and speak/ }));
    recogInstances[0].onerror({ error: "not-allowed" });
    expect(await screen.findByText(/microphone is blocked/)).toBeInTheDocument();
  });

  it("shows a readable message if the server fails", async () => {
    const mock = setup();
    mock.onPost("/assistant/ask").reply(429, { success: false, error: { code: "RATE_LIMITED", message: "You are asking very fast. Please wait a moment." } });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Ask RideX" }));
    await userEvent.type(screen.getByLabelText("Or type your question"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(/asking very fast/)).toBeInTheDocument();
  });

  it("stops speaking and listening when closed", async () => {
    setup(); mount();
    await userEvent.click(screen.getByRole("button", { name: "Ask RideX" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
  });
});
