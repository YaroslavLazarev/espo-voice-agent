# Tasks

Vertical slices. A task is done when its checks pass and the CLAUDE.md verification loop is green. `R*` refers to `requirements.md`, `§*` refers to `design.md`.

## T1. Monorepo scaffold & config — R1
- [x] npm workspaces: `shared`, `backend`, `frontend`; strict `tsconfig` base; ESLint (`typescript-eslint` strict)
- [x] Root scripts: `typecheck`, `lint`, `test`, `dev`
- [x] `backend/src/config.ts` (zod) + `.env.example` + `.gitignore`
- [x] Fastify server with `GET /health` and a `/ws` stub
- [x] Minimal Vite + Vue frontend skeleton (so typecheck/lint run in both packages)
- [x] Tests: config schema
- **Check:** `npm run dev` starts; a bad `.env` gives a readable error

## T2. Browser controller — R2.2, R4.1, R4.2, R4.4, R6.1 (§5)
- [x] `selectors.ts` (verified against the live demo form)
- [x] `BrowserController`: login, navigateToContacts, openCreateForm, fillFields, getScreenState, save, readRecordView, cancel, highlight
- [x] `saveGuard.ts` + unit tests (§4)
- [x] `espocrm.flow.test.ts` (§10)
- **Check:** the integration test passes against the demo

## T3. Live browser view — R2.1 (§6, §9)
- [x] `ScreencastStreamer` with ack and backpressure drop
- [x] `shared/src/protocol.ts` (full WS protocol, §2) + schema tests
- [x] `ClientConnection`: on connect → login → stream frames
- [x] Frontend: `useAgentSocket`, `BrowserViewport`, connection status
- **Check:** opening the frontend shows the live EspoCRM page

## T4. Voice loop without tools — R3, R9 (§7, §9)
- [x] `GeminiSession`: connect with config, typed events, reconnect policy
- [x] Capture and playback worklets, `useAudioStream`, `VoiceControls`
- [x] Transcripts → `EventLog`
- [x] `geminiSession.test.ts` (mocked client: events, reconnect)
- **Check:** a spoken conversation in English works end to end

## T5. Tools & guarded save — R4, R5, R6, R8 (§3, §4, §8)
- [ ] Tool schemas → Gemini function declarations; dispatcher → `BrowserController`
- [ ] State machine + `agent.state` / `tool.call` / `tool.result` events
- [ ] `requestConfirmation`, `saveContact` guard, `resolveDuplicate`
- [ ] System prompt (§8)
- [ ] Tests: dispatcher with a mocked Gemini (tool call → result, save rejected without a snapshot)
- **Check:** create a contact by voice; trying to save without confirmation is refused

## T6. Barge-in & cancellation — R7
- [ ] `interrupted` → `audio.interrupted` → playback `flush()`
- [ ] `toolCallCancellation` → abort a pending save (§4)
- [ ] Tests: cancellation before the click aborts the save; snapshot cleared after a correction
- **Check:** interrupt mid read-back, change the email, get a fresh read-back, then save

## T7. Polish & docs
- [ ] EventLog styling, highlight timing, error messages
- [ ] `Dockerfile` (Playwright base) + `docker-compose.yml`
- [ ] README: setup, `.env`, run, demo script, known limitations
- **Check:** fresh clone → README steps → working demo
