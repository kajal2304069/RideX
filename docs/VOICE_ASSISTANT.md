# Voice assistant ("Ask RideX")

A round microphone button sits on **every page** (including sign-in and the guide). Tap it, pick a language, tap the big mic and speak; the answer is shown in large text **and read aloud in the same language**. A text box is there for browsers without voice input.

## How it works
```
mic ──Web Speech API (recognition, lang = hi-IN …)──► text ──POST /api/assistant/ask {question, language, page}──► answer ──Web Speech API (synthesis)──► speaker
```
- **Speech in/out runs in the browser** (free, no audio leaves for our server; the browser vendor's speech service may process it). Chrome/Edge/Safari support recognition; Firefox does not, so the panel says so and offers typing.
- **The answer** comes from `POST /api/assistant/ask` (public, tightly rate-limited: `ASSISTANT_RATE_LIMIT_MAX`, default 20/min/IP):
  1. **With `ANTHROPIC_API_KEY`**: Claude (`ASSISTANT_MODEL`, default `claude-sonnet-5-5`) answers *in the chosen language*, grounded in the facts in `knowledge.ts`, in at most four short spoken-style sentences, aware of which screen the person is on.
  2. **Without a key, or if the model errors/times out (15 s)**: the best-matching entry of the built-in guide is returned — **English and Hindi only**. For any other language the reply says so (`languageFallback: true`) instead of pretending.
  The helper therefore never goes silent.
- **Languages (14):** English, Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Urdu, Spanish, French, Arabic. The list and speech tags live in `languages.ts`; add one line to add a language.
- The chosen language is remembered on the device.

## Safety decisions
- The model gets **no tools and no user data** — it only explains the app. It cannot book, pay or read anyone's account.
- The person's words go only in the `user` message, never in the system prompt; the prompt tells the model to treat them as a question, not instructions. (Tested.)
- Told never to ask for or repeat passwords, card numbers or one-time codes, and to send emergencies to the local emergency number first.
- Input is validated: ≤ 500 characters, language and page from fixed lists, unknown fields rejected.
- The API key stays on the server and is never in any response (tested).
- Cost control: per-IP limit, 400-token cap, 15 s timeout.

## Honest limits
- Voice quality and recognition accuracy depend on the device; a phone without an installed voice for, say, Telugu will show the answer as text and say so.
- Recognition of regional languages is weaker than English/Hindi and may mishear; typing is always available.
- Non-English/Hindi answers need the API key; they are not human-reviewed, so keep the Help guide as the authoritative reference.
- Not verified here: a real microphone and speaker (tests simulate the speech API), and a live model call (tests mock the HTTP call; no API key was available in the build environment).

## Tests
Backend `tests/integration/assistant.test.ts` (26): FAQ matching incl. Hindi and romanised queries, English/Hindi guide answers, honest language fallback, model request shape (language, grounded facts, page hint, injection hygiene, key header), model error/timeout fallback, key never leaked, validation, language list.
Frontend `src/test/assistant.test.tsx` (7): listens in the chosen language, sends page context, speaks the answer in that language's voice tag, remembers the language, typing fallback, no-voice notice, blocked-mic message, server-error message, stops audio on close.
