/**
 * Real-browser integration flow against ESPOCRM_URL (default: public demo). No Gemini.
 * specs/design.md §10: login -> navigate -> fill -> requestConfirmation -> correction
 * (simulated interruption) -> save rejected -> re-confirm -> save -> verify record view.
 */
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SaveGuard } from '../src/agent/saveGuard.ts';
import { BrowserActionError, BrowserController, launchBrowser } from '../src/browser/BrowserController.ts';
import { HIGHLIGHT_CLASS } from '../src/browser/selectors.ts';
import { DEFAULT_ESPOCRM_URL } from '../src/config.ts';

const runId = Date.now().toString(36);
const contact = {
  salutation: 'Mr.',
  firstName: 'Voice',
  lastName: `Agent${runId}`,
  emailAddress: `voice.agent.${runId}@example.com`,
  phoneNumber: '+15550001111',
} as const;
const correctedEmail = `v.agent.${runId}@example.com`;

let browser: Browser;
let controller: BrowserController;

beforeAll(async () => {
  browser = await launchBrowser(true);
  controller = await BrowserController.create(browser, {
    espocrmUrl: process.env.ESPOCRM_URL ?? DEFAULT_ESPOCRM_URL,
    username: process.env.ESPOCRM_USERNAME || undefined,
    password: process.env.ESPOCRM_PASSWORD || undefined,
  });
  await controller.login();
}, 60_000);

afterAll(async () => {
  await controller.close();
  await browser.close();
});

describe('EspoCRM contact flow', { timeout: 90_000 }, () => {
  it('creates a contact with confirmation and a mid-flow correction', async () => {
    expect((await controller.getScreenState()).view).not.toBe('login');
    // Guard for tsx/esbuild keepNames: evaluate callbacks may reference __name.
    expect(await controller.page.evaluate('typeof __name')).toBe('function');

    expect((await controller.navigateToContacts()).hash).toBe('#Contact');
    expect((await controller.getScreenState()).view).toBe('contactList');

    expect((await controller.openCreateContactForm()).hash).toBe('#Contact/create');
    // Idempotent: second call is a no-op.
    expect((await controller.openCreateContactForm()).hash).toBe('#Contact/create');

    const filled = await controller.fillContactFields(contact);
    expect(filled).toEqual(contact);
    // R2.2: the last touched input is still highlighted (HIGHLIGHT_MS) right after filling.
    expect(await controller.page.locator(`.${HIGHLIGHT_CLASS}`).count()).toBeGreaterThan(0);

    // requestConfirmation: agent reads values back, snapshot stored.
    const guard = new SaveGuard();
    guard.snapshot(filled);

    // Simulated interruption: user corrects the email after the read-back.
    const corrected = await controller.fillContactFields({ emailAddress: correctedEmail });
    expect(corrected).toEqual({ ...contact, emailAddress: correctedEmail });

    const state = await controller.getScreenState();
    expect(state.values).toEqual(corrected);
    expect(guard.check(true, corrected)).toEqual({ ok: false, error: 'form changed since confirmation' });

    // Leaving a dirty form is refused instead of silently discarding input.
    await expect(controller.navigateToContacts()).rejects.toBeInstanceOf(BrowserActionError);
    expect((await controller.getScreenState()).view).toBe('contactCreate');

    // Re-confirm and save.
    guard.snapshot(corrected);
    expect(guard.check(true, corrected)).toEqual({ ok: true });
    const outcome = await controller.clickSave();
    if (outcome.kind !== 'saved') throw new Error(`expected saved, got ${JSON.stringify(outcome)}`);

    expect(outcome.record.hash).toMatch(/^#Contact\/view\/[^/]+$/);
    expect(outcome.record).toMatchObject({
      name: `Mr. Voice Agent${runId}`,
      emailAddress: correctedEmail,
      phoneNumber: contact.phoneNumber,
    });
    expect((await controller.getScreenState()).view).toBe('contactView');
  });

  it('detects the duplicate dialog and lets the user cancel', async () => {
    await controller.openCreateContactForm();
    await controller.fillContactFields({ firstName: contact.firstName, lastName: contact.lastName });

    expect(await controller.clickSave()).toEqual({ kind: 'duplicate' });
    expect((await controller.getScreenState()).dialog).toBe('duplicate');

    expect(await controller.resolveDuplicate('cancel')).toEqual({ kind: 'cancelled' });
    const state = await controller.getScreenState();
    expect(state).toMatchObject({ view: 'contactCreate', dialog: null });

    expect((await controller.cancelForm()).hash).not.toBe('#Contact/create');
  });

  it('reports validation errors when lastName is missing', async () => {
    await controller.openCreateContactForm();
    await controller.fillContactFields({ firstName: 'NoLastName' });

    const outcome = await controller.clickSave();
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') expect(outcome.errors.join(' ')).toMatch(/Last Name is required/);
    expect((await controller.getScreenState()).view).toBe('contactCreate');

    await controller.cancelForm();
    expect((await controller.getScreenState()).view).toBe('contactList');
  });
});
