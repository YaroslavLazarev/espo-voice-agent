# Requirements

Voice agent that creates a Contact in EspoCRM while the user watches the browser live and talks to the agent in English.

## Glossary
- **Agent**: Gemini Live session plus the backend tools it calls.
- **Form**: the EspoCRM Contact create form (`#Contact/create`).
- **Supported fields**: `salutation`, `firstName`, `lastName` (required), `emailAddress`, `phoneNumber`.
- **Snapshot**: the form values the agent read back to the user for confirmation.

## User Stories & Acceptance Criteria

### R1. Configuration
As a developer, I want the app configured via `.env` so I can point it at any EspoCRM instance.
- R1.1 WHEN the backend starts THEN env vars are validated with zod (see CLAUDE.md → Configuration).
- R1.2 WHEN `ESPOCRM_URL` is not set THEN `https://demo.us.espocrm.com/` is used.
- R1.3 WHEN `ESPOCRM_USERNAME` / `ESPOCRM_PASSWORD` are not set THEN login uses whatever the login form pre-fills (public demo).
- R1.4 WHEN a required var is missing or invalid THEN the process exits with a readable message listing the bad vars.

### R2. Live browser view
As a user, I want to see what the agent does in the browser in real time.
- R2.1 WHEN the frontend connects THEN the backend logs into EspoCRM and streams screencast frames to the viewport.
- R2.2 WHEN the agent interacts with an element THEN that element is briefly highlighted on screen.

### R3. Voice conversation
As a user, I want to talk to the agent with my microphone and hear it reply.
- R3.1 WHEN the user presses Start THEN mic audio (16kHz PCM16) streams to Gemini through the backend, and agent audio (24kHz) plays back.
- R3.2 The agent always speaks English.
- R3.3 WHEN speech is transcribed THEN user and agent transcripts appear in the event log.
- R3.4 WHEN the user presses Stop THEN mic capture and the Gemini session end.

### R4. Fill the contact form
As a user, I want to dictate contact details and see them entered into the form.
- R4.1 WHEN the user asks to create a contact THEN the agent navigates to Contacts and opens the create form.
- R4.2 WHEN the user provides field values (all at once or one by one) THEN the agent fills only those fields, without clearing others.
- R4.3 WHEN `lastName` is missing THEN the agent asks for it before requesting confirmation.
- R4.4 WHEN the user asks "what have you filled in so far?" THEN the agent answers from live DOM state (`getScreenState`), not from memory.

### R5. Confirmation and save guard
As a user, I want nothing saved until I explicitly confirm the values.
- R5.1 WHEN the form is filled THEN the agent reads all values back (spelling emails letter by letter) and asks for confirmation.
- R5.2 WHEN the user confirms THEN the agent saves the contact.
- R5.3 WHEN `saveContact` is called without a snapshot THEN it is rejected.
- R5.4 WHEN any field changes after the snapshot THEN `saveContact` is rejected with `"form changed since confirmation"` and the agent must read back again.
- R5.5 WHEN the user declines or corrects a value THEN the agent updates the form and asks for confirmation again.

### R6. Verify the created record
- R6.1 WHEN save succeeds THEN the URL is `#Contact/view/{id}` and the agent reports the saved values read from the record view.
- R6.2 WHEN save fails (validation error, timeout) THEN the agent tells the user what went wrong and stays on the form.

### R7. Barge-in
As a user, I want to interrupt the agent mid-sentence to correct something.
- R7.1 WHEN the user starts speaking while the agent talks THEN agent audio stops immediately (playback queue flushed).
- R7.2 WHEN Gemini cancels a pending tool call THEN idempotent tools may complete; `saveContact` is aborted if Save has not been clicked yet.
- R7.3 WHEN the user corrects a value after an interruption THEN only that field is updated and the snapshot is invalidated.

### R8. Duplicate detection
- R8.1 WHEN EspoCRM shows a duplicate dialog on save THEN the agent tells the user and waits for their choice (create anyway or cancel); it never resolves the dialog on its own.

### R9. Resilience
- R9.1 WHEN the backend↔Gemini connection drops unexpectedly THEN a new session is opened with the same config and the event log shows "reconnected" (the conversation context may be lost).
- R9.2 WHEN the frontend↔backend connection drops THEN the frontend retries with a short backoff and shows the connection status.

## Out of Scope
- Editing, deleting or searching existing contacts; other entities.
- Contact fields beyond the supported fields.
- `sessionResumption` handle persistence; multi-user or authentication for the app itself.
- Local EspoCRM or database containers for tests.
- Languages other than English for the agent.
