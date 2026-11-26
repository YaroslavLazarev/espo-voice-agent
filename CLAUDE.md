## Project Overview

Voice-driven AI browser agent built with TypeScript that operates an EspoCRM instance (default: the public demo `https://demo.eu.espocrm.com/`) in real time.

**Core Workflow:** Create a new Contact end-to-end (`Navigate to Contacts -> Open Create Form -> Fill Fields -> Confirm with User -> Save -> Verify Created Record`), supporting live conversational guidance, clarifications, and mid-speech user interruptions (barge-in).

This is a test assignment / short demo: keep solutions simple and avoid over-engineering.

## Specs (lightweight SDD)
- `specs/requirements.md` — user stories, acceptance criteria (R*), out of scope.
- `specs/design.md` — data flow, WS protocol, state machine, tool contracts (§*).
- `specs/tasks.md` — implementation slices T1–T7 with checkboxes.

Before implementing, read the relevant spec sections. If a decision changes, update the spec first, then the code. Tick tasks in `specs/tasks.md` once the verification loop is green.

## Tech Stack & Architecture
- **Language:** TypeScript (strict mode enabled across all packages; zero `any` types).
- **Monorepo:** npm workspaces (`backend`, `frontend`, `shared`).
- **Backend:** Node.js + Fastify + WebSockets (`ws`) + Playwright (Chromium).
- **Frontend:** Vue 3 (`<script setup lang="ts">`) + Vite + TypeScript + Web Audio API (PCM 16kHz input / 24kHz output).
- **AI / Voice Engine:** Google Gemini Multimodal Live API (`@google/genai`) for real-time bidirectional audio streaming, native barge-in handling, and strongly-typed Function Calling (validated with `zod`).
- **Data Flow:** `Frontend <-> Backend <-> Gemini Live`. The frontend never talks to Gemini directly; the Gemini API key lives only on the backend.
- **Live Browser Stream:** Chrome DevTools Protocol (`Page.startScreencast`) streaming JPEG frames over WebSocket to a frontend `<canvas>` / `<img>` viewport.

## Configuration
All config comes from `.env` (with a committed `.env.example`) and is validated at startup with a zod schema (`backend/src/config.ts`). Fail fast with a readable error if invalid.

| Variable | Required | Default |
|---|---|---|
| `GEMINI_API_KEY` | yes | — |
| `GEMINI_MODEL` | no | a current native-audio Live model (verify name in docs) |
| `ESPOCRM_URL` | no | `https://demo.eu.espocrm.com/` (must be a valid URL) |
| `ESPOCRM_USERNAME` | no | — (public demo pre-fills `Administrator`) |
| `ESPOCRM_PASSWORD` | no | — (public demo has no password) |
| `PORT` | no | `3000` |
| `BROWSER_HEADLESS` | no | `true` (set `false` to watch Chromium locally) |

Never commit `.env`.

## Directory Structure
```text
/
├── shared/
│   └── src/                # Zod schemas + inferred types for WebSocket messages (used by backend & frontend)
├── backend/
│   ├── src/
│   │   ├── agent/          # Gemini Live session manager, system prompt, tool definitions
│   │   ├── browser/        # Playwright controller, selectors.ts (all EspoCRM selectors), CDP screencast streamer
│   │   ├── schemas/        # Zod schemas for tool arguments
│   │   ├── config.ts       # Zod-validated env config
│   │   ├── server.ts       # Fastify HTTP + WebSocket entry point
│   │   └── types.ts        # Backend-only TypeScript interfaces
│   └── tests/              # Unit & integration tests (Vitest)
├── frontend/
│   ├── src/
│   │   ├── composables/    # useAudioStream.ts, useAgentSocket.ts
│   │   ├── components/     # BrowserViewport.vue, VoiceControls.vue, EventLog.vue
│   │   ├── worklets/       # AudioWorklet processors (capture + resample, playback)
│   │   └── App.vue
├── .env.example
├── docker-compose.yml
└── Dockerfile              # Based on mcr.microsoft.com/playwright (Chromium + deps preinstalled)
```

## Coding Standards & Conventions
- **Strict TypeScript**: Never use `any` or `@ts-ignore`. Validate all external inputs (WebSocket payloads, LLM tool call arguments, environment variables) at runtime using zod. Enforced by ESLint (`typescript-eslint` strict, `no-explicit-any`).
- **Modular Design**: Keep WebSocket transport logic decoupled from Playwright DOM automation and Gemini Live session state.
- **EspoCRM DOM Interaction Rules**:
    - EspoCRM uses Backbone.js/jQuery. Never mutate input.value silently.
    - Inject a brief visual highlight outline onto interacted DOM elements so the user sees what the agent is modifying on screen.
    - Always use Playwright's locator.fill() or dispatch input and change events with { bubbles: true }, followed by blur(), so Backbone models sync properly.
    - Prefer stable attributes over brittle CSS classes. Keep all selectors in `browser/selectors.ts` and verify them against the live form.
    - Target the actual `<input>`, not the field container: e.g. `input[data-name="firstName"]`, `input[data-name="lastName"]` (both live inside the composite `name` / personName field, together with `select[data-name="salutationName"]`), `button[data-action="save"]`.
    - Email and phone are multi-value fields (phone also has a type `<select>` and "add" buttons). Fill only the first/primary entry.
    - Verified selectors live in `backend/src/browser/selectors.ts` (see `specs/design.md` §5). Email/phone inputs have no `data-name`; scope them by the `.field[data-name=...]` container. Salutation (and phone type) are selectize widgets: choose by clicking the widget and the option, never by setting the hidden `<select>`.
    - Code passed to `page.evaluate` runs in the browser. Never pass functions as arguments; `__name` is polyfilled by the init script because tsx/esbuild `keepNames` injects it.
    - `lastName` is required for Contact.
    - Handle the duplicate-detection modal on save: EspoCRM can show a "possible duplicate" dialog. Report it to the user and wait for their decision; never confirm it automatically.
- **Vue 3 Conventions**: Use Composition API with <script setup lang="ts"> and extract Web Audio / WebSocket logic into reusable composables.

## Audio
- Capture with `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`. Echo cancellation is mandatory or the agent hears its own voice and triggers false barge-ins.
- Use AudioWorklet (not ScriptProcessorNode). The browser usually runs at 44.1/48kHz, so resample to 16kHz PCM16 mono before sending.
- Playback at 24kHz with a queue that can be flushed instantly on interruption.

## Gemini Live Session
- Enable `contextWindowCompression` (sliding window) in the Live connect config if the selected model supports it.
- Simple reconnect: if the backend↔Gemini WS closes unexpectedly, open a new session with the same config and notify the frontend (event log). Do NOT implement sessionResumption handle persistence.
- Frontend↔backend WS also reconnects simply (retry with short backoff).

## CDP Screencast
- Acknowledge every frame with `Page.screencastFrameAck` or the stream stalls.
- Set `format: 'jpeg'`, a reasonable `quality`, `maxWidth`/`maxHeight`, and `everyNthFrame` to limit bandwidth.
- One browser context per connected frontend client.

## Agent Tools
All tool args are validated with zod. Tools:

| Tool | Idempotent | Purpose |
|---|---|---|
| `navigateToContacts` | yes | Open `#Contact` list |
| `openCreateContactForm` | yes | Open `#Contact/create` (no-op if already there) |
| `fillContactFields` | yes | Partial update: `{ salutation?, firstName?, lastName?, emailAddress?, phoneNumber?, ... }`. Only provided fields change |
| `getScreenState` | yes | Live DOM input values + current URL hash |
| `requestConfirmation` | yes | Stores the snapshot of current form values for read-back (requires `lastName`) |
| `saveContact` | **no** | Requires `{ confirmed: true }`; guarded server-side (see below) |
| `resolveDuplicate` | **no** | `{ action: 'create' \| 'cancel' }`, only after the user decides |
| `cancelForm` | yes | Discard the create form |

Full contracts: `specs/design.md` §4.

## Agent Behavior & Safety Guardrails (Domain Critical)

- **Never Auto-Save (prompt + code)**: The agent must first fill the form on screen, read the entered values back to the user, and wait for explicit confirmation before calling `saveContact`. This is also enforced in code:
    - `requestConfirmation` stores a hash of the current form values (snapshot taken from the DOM); any `fillContactFields` clears it.
    - `saveContact` rejects with `"form changed since confirmation"` if `confirmed !== true`, if there is no snapshot, or if the current DOM values' hash differs from the snapshot.
- **Email Read-Back**: Speech recognition often mangles emails. The agent spells email addresses letter by letter when reading back and asks for clarification when ambiguous.
- **Barge-In & State Recovery**:
    - On the Gemini `interrupted` event: immediately flush frontend audio playback and process the user's correction.
    - On `toolCallCancellation`: idempotent tools (`fillContactFields`, navigation, `getScreenState`) may finish; a pending `saveContact` MUST be aborted if it has not yet clicked Save.
- **Single Source of Truth**: The `getScreenState` tool reads live DOM input values and the current URL hash (`#Contact/create`, `#Contact/view/{id}`) so the agent can accurately answer questions like "What have you filled in so far?" after an interruption.
- **Language**: The agent always speaks English, regardless of the user's language. This is enforced by the system prompt only: native-audio Live models do not support an explicit `speechConfig.languageCode`, so the code does not set it.

## Mandatory Verification Loop

After implementing or modifying any feature, you MUST execute the following verification steps before finishing your turn:

- **Typecheck & Lint**: Run `npm run typecheck` and `npm run lint` in both backend/ and frontend/.

- **Automated Tests**: Run `npm test` (Vitest). Keep tests lightweight; no extra infrastructure (no local EspoCRM/DB containers). Gemini is always mocked.
    - Zod schema validation for all agent tools and the env config.
    - `saveContact` guard logic (no confirmation / changed form -> rejected).
    - Playwright EspoCRM integration flow against `ESPOCRM_URL`, driving the browser controller directly (no Gemini): login -> navigate -> fill -> update field after simulated interruption -> save -> verify record view. Use unique test data (e.g. timestamp suffix) to avoid duplicate-detection dialogs on the shared demo.

- **Self-Correction Rule**: If typechecking or tests fail, analyze the error, fix the root cause, and re-run the suite. You have up to 3 self-correction iterations. If failures persist after 3 attempts, stop and ask for human guidance with a concise summary of the blocker.
