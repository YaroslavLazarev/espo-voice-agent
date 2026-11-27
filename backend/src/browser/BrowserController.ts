import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import {
  CONTACT_FIELDS,
  contactListRowSchema,
  contactValuesSchema,
  type ContactListRow,
  type ContactFieldsInput,
  type ContactValues,
} from '../schemas/contact.ts';
import { HIGHLIGHT_CLASS, HIGHLIGHT_LEAD_MS, HIGHLIGHT_MS, selectors } from './selectors.ts';

const ACTION_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 30_000;
const SAVE_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_TIMEOUT_MS = 5_000;
const STABLE_READ_ATTEMPTS = 10;
const STABLE_READ_INTERVAL_MS = 300;
export const VIEWPORT = { width: 1280, height: 800 } as const;

/** Expected, user-explainable failure of a browser action (the tool layer returns it as `ok: false`). */
export class BrowserActionError extends Error {
  override name = 'BrowserActionError';
}

export type ScreenView = 'login' | 'contactList' | 'contactCreate' | 'contactView' | 'other';

export interface ScreenState {
  hash: string;
  view: ScreenView;
  /** Live form values; only on the create form. */
  values: ContactValues | null;
  dialog: 'duplicate' | null;
}

export interface RecordView {
  id: string;
  hash: string;
  /** Absolute link to the record (`ESPOCRM_URL` + hash), for the user to open in their own browser. */
  url: string;
  /** As displayed by EspoCRM, e.g. "Mr. John Smith". */
  name: string;
  emailAddress: string;
  phoneNumber: string;
}

export interface ContactList {
  hash: string;
  /** The text filter now applied ('' = none). */
  search: string;
  contacts: ContactListRow[];
  /** More rows exist beyond the first page ("Show more"). */
  hasMore: boolean;
}

export type SaveOutcome =
  | { kind: 'saved'; record: RecordView }
  | { kind: 'duplicate' }
  | { kind: 'invalid'; errors: string[] };

export interface BrowserControllerOptions {
  espocrmUrl: string;
  username: string | undefined;
  password: string | undefined;
}

export function launchBrowser(headless: boolean): Promise<Browser> {
  return chromium.launch({ headless });
}

export function viewFromHash(hash: string, onLoginPage: boolean): ScreenView {
  if (onLoginPage) return 'login';
  if (hash === '#Contact/create') return 'contactCreate';
  if (/^#Contact\/view\/[^/]+$/.test(hash)) return 'contactView';
  if (/^#Contact(\/list.*)?$/.test(hash)) return 'contactList';
  return 'other';
}

/**
 * Injected into every document as a plain string (never transpiled):
 * - `__name` no-op: tsx/esbuild `keepNames` wraps functions in `__name(...)`, and those wrappers
 *   end up inside page.evaluate callbacks, where the browser has no such helper.
 * - highlight style used by `highlight()`.
 */
const INIT_SCRIPT = `
  window.__name = window.__name || function (fn) { return fn; };
  (function () {
    function inject() {
      var style = document.createElement('style');
      style.textContent = '.${HIGHLIGHT_CLASS}{outline:3px solid #f59e0b !important;outline-offset:2px !important;box-shadow:0 0 0 6px rgba(245,158,11,.25) !important;transition:outline-color .2s;}';
      document.head.appendChild(style);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
    else inject();
  })();
`;

const TEXT_FIELDS = ['firstName', 'lastName', 'emailAddress', 'phoneNumber'] as const;

const hasAnyValue = (values: ContactValues): boolean => CONTACT_FIELDS.some((field) => values[field] !== '');

/** Leaving a filled create form would make EspoCRM ask "Are you sure?"; the user must decide first. */
function assertNoUnsavedForm(state: ScreenState): void {
  if (state.view === 'contactCreate' && state.values !== null && hasAnyValue(state.values)) {
    throw new BrowserActionError(
      'The create form has unsaved values. Ask the user whether to discard them, then call cancelForm.',
    );
  }
}

/**
 * Playwright automation of EspoCRM. Knows nothing about Gemini or WebSockets.
 * One instance = one browser context = one connected client.
 */
export class BrowserController {
  private constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly options: BrowserControllerOptions,
  ) {}

  static async create(browser: Browser, options: BrowserControllerOptions): Promise<BrowserController> {
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript({ content: INIT_SCRIPT });
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    return new BrowserController(context, page, options);
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  // ---------------------------------------------------------------- login

  async login(): Promise<void> {
    const { page } = this;
    await page.goto(this.options.espocrmUrl, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT_MS });
    await page
      .locator(`${selectors.login.username}, ${selectors.appShell}`)
      .first()
      .waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
    if (await this.isLoggedIn()) return;

    if (this.options.username !== undefined) await page.fill(selectors.login.username, this.options.username);
    if (this.options.password !== undefined) await page.fill(selectors.login.password, this.options.password);
    await page.click(selectors.login.submit);
    try {
      await page.waitForSelector(selectors.appShell, { state: 'attached', timeout: LOGIN_TIMEOUT_MS });
    } catch {
      throw new BrowserActionError('Login to EspoCRM failed: check ESPOCRM_URL / ESPOCRM_USERNAME / ESPOCRM_PASSWORD');
    }
  }

  private async isLoggedIn(): Promise<boolean> {
    return (await this.page.locator(selectors.appShell).count()) > 0;
  }

  // ----------------------------------------------------------- navigation

  async navigateToContacts(): Promise<{ hash: string }> {
    const state = await this.getScreenState();
    if (state.view === 'contactList') return { hash: state.hash };
    assertNoUnsavedForm(state);
    await this.clickVisible(this.page.locator(selectors.nav.contacts).first());
    await this.page.locator(selectors.list.createButton).first().waitFor({ state: 'visible' });
    await this.waitForNetworkIdle();
    return { hash: await this.hash() };
  }

  /** Opens the list, applies the text filter (`''` clears it) and reads the first page of rows. */
  async listContacts(search = ''): Promise<ContactList> {
    const { page } = this;
    await this.navigateToContacts();
    const input = page.locator(selectors.list.searchInput).first();
    await input.waitFor({ state: 'visible' });
    const wanted = search.trim();
    // EspoCRM remembers the last filter, so a leftover one is cleared too.
    if ((await input.inputValue()) !== wanted) {
      await this.highlight(input);
      await input.fill(wanted);
      const response = page
        .waitForResponse((r) => r.request().method() === 'GET' && /\/api\/v1\/Contact\?/.test(r.url()))
        .catch(() => undefined);
      await this.clickVisible(page.locator(selectors.list.searchButton).first());
      await response;
    }
    await this.waitForNetworkIdle();
    const contacts = await this.readStable(() => this.readListRows());
    const hasMore = await page.locator(selectors.list.showMore).first().isVisible();
    return { hash: await this.hash(), search: wanted, contacts, hasMore };
  }

  private async readListRows(): Promise<ContactListRow[]> {
    const raw = await this.page.evaluate((s) => {
      const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll(s.row)).map((row) => ({
        id: row.getAttribute('data-id') ?? '',
        name: text(row.querySelector(s.rowName)),
        account: text(row.querySelector(s.rowAccount)),
        emailAddress: row.querySelector(s.rowEmail)?.getAttribute('data-email-address') ?? '',
        phoneNumber: row.querySelector(s.rowPhone)?.getAttribute('data-phone-number') ?? '',
      }));
    }, {
      row: selectors.list.row,
      rowName: selectors.list.rowName,
      rowAccount: selectors.list.rowAccount,
      rowEmail: selectors.list.rowEmail,
      rowPhone: selectors.list.rowPhone,
    });
    return contactListRowSchema.array().parse(raw);
  }

  /** Opens `#Contact/view/{id}`: clicks the list row when it is on screen, otherwise sets the hash. */
  async openContact(id: string): Promise<RecordView> {
    const { page } = this;
    const target = `#Contact/view/${id}`;
    const state = await this.getScreenState();
    if (state.hash !== target) {
      assertNoUnsavedForm(state);
      const link = page.locator(selectors.list.rowLink(id)).first();
      if (state.view === 'contactList' && (await link.count()) > 0) await this.clickVisible(link);
      else await page.evaluate((hash) => { location.hash = hash; }, target);
      await page.waitForFunction((hash) => location.hash === hash, target);
    }
    try {
      return await this.readRecordView();
    } catch {
      // An unknown id makes EspoCRM replace the whole app with a 404 page; reload on the list.
      await this.recoverToContactList();
      throw new BrowserActionError(`Could not open contact ${id}; call listContacts to get a valid id`);
    }
  }

  private async recoverToContactList(): Promise<void> {
    const { page } = this;
    await page.evaluate(() => {
      location.hash = '#Contact';
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT_MS });
    await page.locator(selectors.appShell).waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
    await page.locator(selectors.list.createButton).first().waitFor({ state: 'visible' });
  }

  async openCreateContactForm(): Promise<{ hash: string }> {
    const view = (await this.getScreenState()).view;
    if (view === 'contactCreate') return { hash: await this.hash() };
    if (view !== 'contactList') await this.navigateToContacts();
    await this.clickVisible(this.page.locator(selectors.list.createButton).first());
    await this.waitForCreateFormReady();
    return { hash: await this.hash() };
  }

  async cancelForm(): Promise<{ hash: string }> {
    if ((await this.getScreenState()).view !== 'contactCreate') return { hash: await this.hash() };
    await this.clickVisible(this.page.locator(selectors.form.cancel));
    await this.page.waitForFunction(() => location.hash !== '#Contact/create');
    return { hash: await this.hash() };
  }

  // ------------------------------------------------------------- the form

  async fillContactFields(fields: ContactFieldsInput): Promise<ContactValues> {
    await this.requireCreateForm();
    const { page } = this;
    if (fields.salutation !== undefined) await this.selectSalutation(fields.salutation);
    for (const field of TEXT_FIELDS) {
      const value = fields[field];
      if (value === undefined) continue;
      const input = page.locator(selectors.form[field]).first();
      await this.highlight(input);
      await input.fill(value);
      await input.blur();
    }
    return this.readFormValues();
  }

  private async selectSalutation(value: ContactValues['salutation']): Promise<void> {
    const current = await this.page.locator(selectors.form.salutationSelect).inputValue();
    if (current === value) return;
    const widget = this.page.locator(selectors.form.salutationWidget);
    await this.highlight(widget);
    await widget.click();
    await this.page.locator(selectors.form.salutationOption(value)).click();
  }

  private async readFormValues(): Promise<ContactValues> {
    const raw = await this.page.evaluate((s) => {
      const value = (selector: string): string =>
        document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value ?? '';
      return {
        salutation: value(s.salutationSelect),
        firstName: value(s.firstName),
        lastName: value(s.lastName),
        emailAddress: value(s.emailAddress),
        phoneNumber: value(s.phoneNumber),
      };
    }, {
      salutationSelect: selectors.form.salutationSelect,
      firstName: selectors.form.firstName,
      lastName: selectors.form.lastName,
      emailAddress: selectors.form.emailAddress,
      phoneNumber: selectors.form.phoneNumber,
    });
    return contactValuesSchema.parse(raw);
  }

  // ----------------------------------------------------------------- save

  /** Clicks Save. The caller MUST have passed the SaveGuard check first. */
  async clickSave(): Promise<SaveOutcome> {
    await this.requireCreateForm();
    const { page } = this;
    // Drop stale "Not valid" alerts from a previous attempt so they are not mistaken for this one.
    await page.evaluate((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        el.remove();
      });
    }, selectors.form.errorAlert);
    await this.clickVisible(page.locator(selectors.form.save));
    return this.waitForSaveOutcome();
  }

  async resolveDuplicate(action: 'create' | 'cancel'): Promise<SaveOutcome | { kind: 'cancelled' }> {
    if ((await this.getScreenState()).dialog !== 'duplicate') {
      throw new BrowserActionError('No duplicate dialog is open');
    }
    const { page } = this;
    if (action === 'cancel') {
      await this.clickVisible(page.locator(selectors.duplicateDialog.cancel));
      await page.locator(selectors.duplicateDialog.root).waitFor({ state: 'detached' });
      return { kind: 'cancelled' };
    }
    await this.clickVisible(page.locator(selectors.duplicateDialog.create));
    return this.waitForSaveOutcome();
  }

  private async waitForSaveOutcome(): Promise<SaveOutcome> {
    const { page } = this;
    let kind: string;
    try {
      const handle = await page.waitForFunction(
        ({ duplicate, alert }) => {
          if (/^#Contact\/view\//.test(location.hash)) return 'saved';
          if (document.querySelector(duplicate)) return 'duplicate';
          if (document.querySelector(alert)) return 'invalid';
          return false;
        },
        { duplicate: selectors.duplicateDialog.root, alert: selectors.form.errorAlert },
        { timeout: SAVE_TIMEOUT_MS },
      );
      kind = String(await handle.jsonValue());
    } catch {
      throw new BrowserActionError('Save did not complete in time; the form is still open');
    }

    if (kind === 'saved') return { kind, record: await this.readRecordView() };
    if (kind === 'duplicate') return { kind };
    const errors = await page
      .locator(selectors.form.validationPopover)
      .allInnerTexts()
      .then((texts) => texts.map((t) => t.trim()).filter((t) => t !== ''));
    return { kind: 'invalid', errors: errors.length > 0 ? errors : ['Not valid'] };
  }

  async readRecordView(): Promise<RecordView> {
    const { page } = this;
    const hash = await this.hash();
    const id = /^#Contact\/view\/([^/]+)$/.exec(hash)?.[1];
    if (id === undefined) throw new BrowserActionError('Not on a contact record view');
    await page.locator(selectors.recordView.nameRendered).first().waitFor({ state: 'visible' });
    await this.waitForNetworkIdle();

    const read = async (): Promise<RecordView> => {
      const attr = async (selector: string, name: string): Promise<string> => {
        const el = page.locator(selector).first();
        return (await el.count()) > 0 ? ((await el.getAttribute(name)) ?? '') : '';
      };
      return {
        id,
        hash,
        url: new URL(hash, this.options.espocrmUrl).href,
        name: (await page.locator(selectors.recordView.name).first().innerText()).replace(/\s+/g, ' ').trim(),
        emailAddress: await attr(selectors.recordView.emailAddress, 'data-email-address'),
        phoneNumber: await attr(selectors.recordView.phoneNumber, 'data-phone-number'),
      };
    };

    // The detail view re-renders after fetching the saved model.
    return this.readStable(read);
  }

  /** Reads until two consecutive reads agree (EspoCRM re-renders views after fetching data). */
  private async readStable<T>(read: () => Promise<T>): Promise<T> {
    let previous = await read();
    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt++) {
      await this.page.waitForTimeout(STABLE_READ_INTERVAL_MS);
      const current = await read();
      if (JSON.stringify(current) === JSON.stringify(previous)) return current;
      previous = current;
    }
    return previous;
  }

  // ---------------------------------------------------------------- state

  async getScreenState(): Promise<ScreenState> {
    const { page } = this;
    const hash = await this.hash();
    const onLoginPage = (await page.locator(selectors.login.username).count()) > 0;
    const view = viewFromHash(hash, onLoginPage);
    const dialog = (await page.locator(selectors.duplicateDialog.root).count()) > 0 ? 'duplicate' : null;
    const formReady = view === 'contactCreate' && (await page.locator(selectors.form.lastName).count()) > 0;
    return { hash, view, values: formReady ? await this.readFormValues() : null, dialog };
  }

  // -------------------------------------------------------------- helpers

  private async hash(): Promise<string> {
    return this.page.evaluate(() => location.hash);
  }

  /** EspoCRM renders form fields asynchronously; filling too early gets wiped by a re-render. */
  private async waitForCreateFormReady(): Promise<void> {
    const { form } = selectors;
    for (const selector of [form.salutationWidget, form.firstName, form.lastName, form.emailAddress, form.phoneNumber]) {
      await this.page.locator(selector).first().waitFor({ state: 'visible' });
    }
    await this.waitForNetworkIdle();
  }

  /** Best effort: EspoCRM is an SPA; wait for its XHRs to settle, but never fail on it. */
  private async waitForNetworkIdle(): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined);
  }

  private async requireCreateForm(): Promise<void> {
    if ((await this.getScreenState()).view !== 'contactCreate') {
      throw new BrowserActionError('The contact create form is not open; call openCreateContactForm first');
    }
  }

  private async clickVisible(locator: Locator): Promise<void> {
    await this.highlight(locator);
    await locator.click();
  }

  /** Brief outline so the user sees what the agent is touching. Never fails the action. */
  private async highlight(locator: Locator): Promise<void> {
    const shown = await locator
      .evaluate(
        (el, { cls, ms }) => {
          el.classList.add(cls);
          setTimeout(() => {
            el.classList.remove(cls);
          }, ms);
        },
        { cls: HIGHLIGHT_CLASS, ms: HIGHLIGHT_MS },
      )
      .then(() => true)
      .catch(() => false);
    if (shown) await this.page.waitForTimeout(HIGHLIGHT_LEAD_MS);
  }
}
