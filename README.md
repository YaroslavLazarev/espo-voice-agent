# EspoCRM Voice Agent

A voice-driven browser agent that creates, finds and opens Contacts in [EspoCRM](https://www.espocrm.com/) while you talk to it.
You speak; Gemini Live listens, drives a real Chromium browser through Playwright, and you watch the CRM page update
live in the app. The agent fills the form, reads the values back, and saves only after you say "yes". You can
interrupt it at any time.

```
Browser (Vue)  ◀── WebSocket ──▶  Backend (Fastify)  ◀──▶  Gemini Live API
  mic / speaker                     ├─ Playwright → EspoCRM
  live viewport  ◀── JPEG frames ── └─ CDP screencast
  event log
```

The Gemini API key stays on the backend; the frontend only talks to the backend.

## Requirements

- A Gemini API key with access to the Live API ([Google AI Studio](https://aistudio.google.com/apikey)).
- Either **Docker** (with Compose), or **Node.js 24+** and npm.
- A desktop browser with a microphone (Chrome or Edge recommended). Use headphones for the best barge-in experience
  (echo cancellation is on, but speakers still leak into the mic).

## Configuration

```bash
cp .env.example .env
# then set GEMINI_API_KEY in .env
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | — | |
| `GEMINI_MODEL` | no | `gemini-3.8-live` | a native-audio Live model |
| `ESPOCRM_URL` | no | `https://demo.eu.espocrm.com/` | any EspoCRM instance |
| `ESPOCRM_USERNAME` | no | — | the public demo pre-fills it |
| `ESPOCRM_PASSWORD` | no | — | the public demo has none |
| `PORT` | no | `3000` | backend port |
| `BROWSER_HEADLESS` | no | `true` | `false` opens a visible Chromium window (local run only) |

The config is validated at startup; an invalid `.env` stops the server with a readable list of problems.

## Run

### Docker (simplest)

```bash
docker compose up --build
```

Open <http://localhost:3000>.

### Local

```bash
npm install
npx playwright install chromium   # once
npm run dev
```

Open <http://localhost:5173>. Vite serves the frontend and proxies `/ws` to the backend on `PORT`.

> The microphone only works on a secure page: `http://localhost` or HTTPS. Opening the app by a LAN IP over plain
> HTTP will not get mic access.

## Demo script

1. Wait until the status badges show the server and browser as ready. The viewport shows EspoCRM, logged in.
2. Press **Start** and allow the microphone.
3. Say: *"Create a new contact: Mister John Smith, email john dot smith at example dot com, phone 555 123 4567."*
   - The agent opens Contacts → Create; each field it fills gets a short orange outline.
   - It reads the values back and spells the email letter by letter.
4. **Interrupt** while it is reading back: *"Wait, the email is j smith at example dot com."*
   - Its audio stops at once, it changes only the email, says what it changed (old → new), and reads the values back
     again.
5. Ask: *"What have you filled in so far?"*. It answers from the live form, not from memory.
6. Say *"Yes, save it."* The record view opens and the agent reports the saved values. The event log shows a link to
   the saved record, so you can open it in your own browser.
7. Say *"Show me the contacts"*, then *"Find Smith"* and *"Open John Smith"*. The agent filters the list with
   EspoCRM's search, clicks the row, and reads the contact's details from the record view. If several match, it asks
   which one.

Things to try: saving before confirming (it refuses), leaving out the last name (it asks for it), or creating the same
person twice (EspoCRM shows a duplicate dialog; the agent asks whether to create anyway or cancel).

No microphone? Type in the **"Or type a message…"** field once the session has started.

## How saving is guarded

The rule "never save without confirmation" lives in the code as well as the prompt:

- `requestConfirmation` stores a snapshot hash of the form values read from the DOM.
- Any `fillContactFields` clears the snapshot.
- `saveContact` is rejected unless `confirmed: true`, a snapshot exists, and the live form still matches it.
- If the user barges in while a save is pending (`toolCallCancellation`), the save is aborted as long as Save has not
  been clicked yet.

## Development

```bash
npm run typecheck   # all workspaces
npm run lint
npm test            # Vitest; includes a real-browser flow against ESPOCRM_URL
```

Gemini is always mocked in tests. The EspoCRM flow test uses a timestamped last name so it does not trigger
duplicate detection on the shared demo. It needs network access and a Chromium install.

Layout: `shared/` (zod WebSocket protocol), `backend/` (Fastify, Gemini Live session, tools, Playwright controller),
`frontend/` (Vue 3, audio worklets). Specs: `specs/requirements.md`, `specs/design.md`, `specs/tasks.md`.

## Known limitations

- **Contacts only; create, list and open:** salutation, first/last name, the primary email and phone. Existing
  contacts are read-only (nothing is edited or deleted). The list returns only the first page (20 rows) and uses the
  plain text search, with no advanced filters or sorting.
- **Shared public demo:** `demo.eu.espocrm.com` is used by everyone and reset from time to time. It can be slow, and
  the records you create are public.
- **Reconnects lose context:** if the Gemini connection drops, a new session starts with only a hint about the
  current screen. Earlier conversation is lost (no session resumption).
- **English only:** the agent always speaks English (set by the prompt; native-audio models have no language setting).
- **Speech recognition of emails:** emails are often misheard. The agent spells them back, but check before you say
  "yes".
- **Single user:** each browser tab gets its own Chromium context, and there is no app login. Do not expose it publicly.
- **Selectors** were verified against the EspoCRM demo version current in November 2026. Another EspoCRM version
  may need changes in `backend/src/browser/selectors.ts`.
