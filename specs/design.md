# Design

## 1. Data Flow

```text
 Browser (Vue)                      Backend (Fastify)                    External
┌───────────────────┐  WS /ws   ┌───────────────────────────┐
│ useAudioStream    │──audio───▶│ ClientConnection          │   Live WS   ┌─────────────┐
│  (worklet 16k)    │◀─audio────│  ├─ GeminiSession ────────┼────────────▶│ Gemini Live │
│ useAgentSocket    │◀─events───│  │   (tools dispatcher)   │◀────────────│             │
│ BrowserViewport   │◀─frames───│  ├─ BrowserController ────┼──Playwright─▶ EspoCRM     │
│ EventLog          │           │  └─ ScreencastStreamer(CDP)│             └─────────────┘
└───────────────────┘           └───────────────────────────┘
```

- One `ClientConnection` per frontend WS, owning one `GeminiSession`, one Playwright browser context and one screencast.
- `GeminiSession` knows nothing about WS; it emits typed events (`audio`, `interrupted`, `transcript`, `toolCall`, `toolCancelled`, `status`). `ClientConnection` maps them to WS messages.
- `BrowserController` knows nothing about Gemini; it exposes async methods matching the tools.

## 2. WebSocket Protocol (frontend ↔ backend)

JSON text frames. Schemas live in `shared/src/protocol.ts` as a zod discriminated union on `type`; both sides parse every message. Audio and frames are base64 (simple; fine for a demo).

### Client → Server
| type | payload | notes |
|---|---|---|
| `session.start` | — | open Gemini session, start mic streaming |
| `session.stop` | — | close Gemini session |
| `audio.input` | `{ data: string }` | base64 PCM16 mono 16kHz chunk (~20–100 ms) |
| `text.input` | `{ text: string }` | optional typed input, handy for debugging |

### Server → Client
| type | payload | notes |
|---|---|---|
| `connection.status` | `{ browser: Status, gemini: Status }` | `Status = 'connecting' \| 'ready' \| 'reconnecting' \| 'closed' \| 'error'` |
| `screencast.frame` | `{ data: string, width: number, height: number }` | base64 JPEG |
| `audio.output` | `{ data: string }` | base64 PCM16 mono 24kHz |
| `audio.interrupted` | — | frontend flushes the playback queue at once |
| `transcript` | `{ role: 'user' \| 'agent', text: string, final: boolean }` | from Live input/output transcription |
| `agent.state` | `{ state: AgentState }` | see §3 |
| `tool.call` | `{ id, name, args }` | for the event log |
| `tool.result` | `{ id, name, ok: boolean, result?: unknown, error?: string }` | for the event log |
| `error` | `{ message: string }` | |

## 3. Agent State Machine (backend, per connection)

```text
idle ──navigateToContacts/openCreateContactForm──▶ form_open
form_open ──fillContactFields──▶ filling
filling ──requestConfirmation──▶ awaiting_confirmation        (snapshot stored)
awaiting_confirmation ──fillContactFields──▶ filling          (snapshot cleared)
awaiting_confirmation ──saveContact(ok)──▶ saving ──▶ saved
saving ──duplicate dialog──▶ duplicate_dialog ──resolveDuplicate──▶ saved | form_open
saving ──validation error──▶ filling
any ──cancelForm──▶ idle;  any ──unexpected error──▶ error (agent explains, can retry)
```

The state is reported to the frontend (`agent.state`) and returned in every tool result so the model stays in sync.

## 4. Tools

All args validated with zod in `backend/src/schemas/tools.ts`; the same schemas generate the Gemini function declarations. Every result has the shape `{ ok: true, state, ...data } | { ok: false, state, error }`. Errors are returned to the model, never thrown into the session.

| Tool | Args | Result data | Notes |
|---|---|---|---|
| `navigateToContacts` | — | `{ hash }` | |
| `openCreateContactForm` | — | `{ hash }` | no-op if already on `#Contact/create` |
| `fillContactFields` | `{ salutation?: 'Mr.'\|'Ms.'\|'Mrs.'\|'Dr.', firstName?, lastName?, emailAddress?: email, phoneNumber? }` (≥1 field) | `{ values }` | fills only the given fields; clears the snapshot |
| `getScreenState` | — | `{ hash, values, dialog?: 'duplicate' }` | reads the live DOM |
| `requestConfirmation` | — | `{ values }` | requires `lastName`; stores the snapshot; the model must read these values back |
| `saveContact` | `{ confirmed: true }` | `{ id, hash, values }` | guard: snapshot exists and the current DOM hash equals the snapshot hash; then click Save and wait for `#Contact/view/{id}`; values are read from the record view |
| `resolveDuplicate` | `{ action: 'create' \| 'cancel' }` | `{ id?, hash }` | only in `duplicate_dialog`, only after the user decides |
| `cancelForm` | — | `{ hash }` | |

**Save guard** (`backend/src/agent/saveGuard.ts`, pure and unit-tested): `hash = sha256(JSON of normalized values with sorted keys)`. Normalization trims strings and lowercases email.

**Cancellation:** the `toolCallCancellation` ids are put into a set. `saveContact` checks the set right before clicking Save and aborts if its id is there. Other tools ignore cancellation.

## 5. Browser Controller

- Chromium (headless by default), viewport 1280×800, one context per connection.
- **Login:** open `ESPOCRM_URL` → fill `#field-userName` / `#field-password` only if `ESPOCRM_USERNAME` / `ESPOCRM_PASSWORD` are set (the public demo pre-fills `admin` / `1`) → click `#btn-login` → wait for `#navbar` (attached; it is not "visible" itself). Skip if already logged in.
- **Navigation:** visible clicks so the user can follow along: sidebar `#navbar a[href="#Contact"]` → wait for the list's `a[data-action="create"]` → click it → wait for `input[data-name="lastName"]`. `openCreateContactForm` is a no-op on `#Contact/create`.
- **Dirty form:** leaving a filled create form makes EspoCRM ask "Are you sure you want to leave the form?". `navigateToContacts` therefore refuses with an error while the form has values; the agent must call `cancelForm` (Cancel button, which leaves without asking) after the user agrees.
- **Fill:** `highlight(locator)` (outline for ~800 ms through a style injected with `addInitScript`) → `locator.fill(value)` → `blur()`. An empty string clears the field.
- **Field selectors (verified on the demo):**
  - `firstName` / `lastName`: `input[data-name="firstName|lastName"]`.
  - `salutation`: hidden `select[data-name="salutationName"]` wrapped by selectize (options exist only in JS) → click `.field[data-name="name"] .selectize-input`, then `.selectize-dropdown .option[data-value="Mr."]`. Values: `''`, `Mr.`, `Ms.`, `Mrs.`, `Dr.`.
  - `emailAddress`: `.field[data-name="emailAddress"] input.email-address` (first one; no `data-name` on the input).
  - `phoneNumber`: `.field[data-name="phoneNumber"] input.phone-number` (first one; type stays at the default `Mobile`).
- **Save outcomes** (`clickSave` waits for the first of these):
  - `saved`: hash becomes `#Contact/view/{id}`.
  - `duplicate`: `.modal.in` containing a `.list-container` ("The record you are creating might already exist"); buttons `button[data-name="save"]` (Create) / `button[data-name="cancel"]`.
  - `invalid`: `.alert-danger` ("Not valid") + `.popover.in` messages (e.g. "Last Name is required"); the hash stays on `#Contact/create`.
- **Read state:** `inputValue()` of each supported field, plus `location.hash`, plus `dialog: 'duplicate' | null`.
- **Record view:** `name` is shown combined (`Mr. John Smith`); email and phone are read from `[data-email-address]` / `[data-phone-number]` attributes.
- **Timeouts:** 10 s per action, 30 s for login; a failure becomes `BrowserActionError`, which the tool layer turns into `{ ok: false, error }`.

## 6. Screencast

CDP session on the page → `Page.startScreencast({ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 })`. On each `Page.screencastFrame`, ack first, then forward the frame. If the WS is backpressured (`bufferedAmount` above a threshold), the frame is dropped.

## 7. Gemini Live Session

- Model from `GEMINI_MODEL` (default `gemini-3.8-live`, the current default native-audio Live model per the docs). Config: `responseModalities: [AUDIO]`, `inputAudioTranscription` and `outputAudioTranscription` on, `contextWindowCompression: { slidingWindow: {} }`, tools from §4, system instruction from §8. No `speechConfig.languageCode`: native-audio models pick the language themselves and do not support setting it, so English comes from the system prompt.
- Audio in: `sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } })`. Audio out: 24 kHz PCM16 from `modelTurn` inline data.
- The SDK client is created with `httpOptions: { apiVersion: 'v1beta' }`: SDK 3.x defaults to `v1`, where the Live endpoint returns 404.
- `GeminiSession` takes the SDK's `live` client as a dependency (`connect()` only), so tests inject a fake.
- **Transcripts:** the backend accumulates transcription chunks per role and sends the whole text so far with `final: false`; it sends `final: true` when the turn ends (user: on `finished` or when the agent starts replying; agent: on `turnComplete` or `interrupted`). The frontend replaces the last non-final line of that role.
- **Reconnect:** on an unexpected close, retry up to 3 times (1 s, 2 s, 4 s), then status `error`. A new session starts with fresh context plus a short text hint with the current `getScreenState`. A failed first connect is reported as `error` without retries.

## 8. System Prompt (skeleton)

```text
You are a voice assistant operating EspoCRM in a browser the user can see.
Goal: create one Contact. Always speak English. Be brief: 1–2 sentences per turn.
Flow: open create form → collect fields (lastName required) → fillContactFields →
requestConfirmation → read back ALL values (spell emails letter by letter) →
wait for an explicit "yes" → saveContact({confirmed:true}) → report saved values.
Never call saveContact without explicit user confirmation of the latest read-back.
If any value changes, call requestConfirmation again before saving.
When unsure what is on screen, call getScreenState; never guess.
If a duplicate dialog appears, tell the user and ask: create anyway or cancel.
If a tool returns ok:false, explain the problem briefly and suggest the next step.
```

## 9. Frontend

- `useAgentSocket`: connect/reconnect with backoff, zod-parse incoming messages, typed `send()`, reactive `status`.
- `useAudioStream`: mic capture worklet (downsample to 16 kHz → PCM16 → base64 chunks); playback worklet with a 24 kHz queue and a `flush()` method.
- Components: `BrowserViewport` (draws frames on a `<canvas>`, decodes only the latest frame), `ConnectionStatus` (server / browser / Gemini badges), `VoiceControls` (Start/Stop, mic level, status), `EventLog` (transcripts, tool calls/results, state changes).

## 10. Testing

| Test | What it covers |
|---|---|
| `schemas.test.ts` | tool args (valid/invalid), env config, WS protocol |
| `saveGuard.test.ts` | no snapshot, changed values, normalization, happy path |
| `espocrm.flow.test.ts` | real browser against `ESPOCRM_URL`, no Gemini: login → navigate → fill → `requestConfirmation` → change one field (simulated interruption) → save rejected → `requestConfirmation` → save → assert `#Contact/view/{id}` and values. Unique `lastName` with a timestamp suffix |
| `geminiSession.test.ts` | mocked Live client: toolCall → dispatch → response; `interrupted` → event; cancellation aborts save |
