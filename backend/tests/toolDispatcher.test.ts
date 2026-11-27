import { LiveServerMessage, type LiveConnectParameters } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { GeminiSession, type LiveClient, type LiveSession } from '../src/agent/GeminiSession.ts';
import { ToolDispatcher, type ContactBrowser, type DispatcherEvent } from '../src/agent/ToolDispatcher.ts';
import { BrowserActionError, type SaveOutcome, type ScreenState } from '../src/browser/BrowserController.ts';
import { EMPTY_CONTACT_VALUES, type ContactValues } from '../src/schemas/contact.ts';
import { toolDeclarations } from '../src/schemas/tools.ts';

const existing = {
  id: 'def456',
  name: 'Frederick Devine',
  account: 'AFP Supply',
  emailAddress: 'f.devine@afp-supply.com',
  phoneNumber: '+491771234567',
};

/** In-memory EspoCRM: a create form whose values change on fill, and a scripted save outcome. */
function fakeBrowser(saveOutcomes: SaveOutcome['kind'][] = ['saved']) {
  let hash = '#Contact';
  let values: ContactValues = { ...EMPTY_CONTACT_VALUES };
  let dialog: ScreenState['dialog'] = null;
  const onForm = () => hash === '#Contact/create';
  const outcome = (): SaveOutcome => {
    const kind = saveOutcomes.shift() ?? 'saved';
    if (kind === 'duplicate') {
      dialog = 'duplicate';
      return { kind };
    }
    if (kind === 'invalid') return { kind, errors: ['Last Name is required'] };
    dialog = null;
    hash = '#Contact/view/abc123';
    const name = [values.salutation, values.firstName, values.lastName].filter(Boolean).join(' ');
    return { kind, record: { id: 'abc123', hash, url: `https://crm.test/${hash}`, name, emailAddress: values.emailAddress, phoneNumber: values.phoneNumber } };
  };
  const browser = {
    navigateToContacts: vi.fn(() => {
      hash = '#Contact';
      return Promise.resolve({ hash });
    }),
    openCreateContactForm: vi.fn(() => {
      if (!onForm()) values = { ...EMPTY_CONTACT_VALUES };
      hash = '#Contact/create';
      return Promise.resolve({ hash });
    }),
    fillContactFields: vi.fn((fields: Partial<ContactValues>) => {
      values = { ...values, ...fields };
      return Promise.resolve(values);
    }),
    getScreenState: vi.fn(() =>
      Promise.resolve<ScreenState>({
        hash,
        view: onForm() ? 'contactCreate' : 'other',
        values: onForm() ? values : null,
        dialog,
      }),
    ),
    clickSave: vi.fn(() => Promise.resolve(outcome())),
    resolveDuplicate: vi.fn((action: 'create' | 'cancel') => {
      if (action === 'cancel') {
        dialog = null;
        return Promise.resolve({ kind: 'cancelled' as const });
      }
      return Promise.resolve(outcome());
    }),
    cancelForm: vi.fn(() => {
      hash = '#Contact';
      return Promise.resolve({ hash });
    }),
    listContacts: vi.fn((search = '') => {
      if (onForm() && Object.values(values).some((v) => v !== '')) {
        return Promise.reject(new BrowserActionError('The create form has unsaved values'));
      }
      hash = '#Contact';
      const contacts = [existing].filter((c) => search === '' || c.name.includes(search));
      return Promise.resolve({ hash, search, contacts, hasMore: false });
    }),
    openContact: vi.fn((id: string) => {
      if (id !== existing.id) return Promise.reject(new BrowserActionError(`Could not open contact ${id}`));
      hash = `#Contact/view/${id}`;
      const { id: recordId, name, emailAddress, phoneNumber } = existing;
      return Promise.resolve({ id: recordId, name, emailAddress, phoneNumber, hash, url: `https://crm.test/${hash}` });
    }),
  } satisfies ContactBrowser;
  return browser;
}

function setup(saveOutcomes?: SaveOutcome['kind'][]) {
  const browser = fakeBrowser(saveOutcomes);
  const events: DispatcherEvent[] = [];
  const dispatcher = new ToolDispatcher({ getBrowser: () => browser, onEvent: (e) => events.push(e) });
  let n = 0;
  const call = (name: string, args: unknown = {}) => dispatcher.dispatch(`c${String(++n)}`, name, args);
  const states = () => events.flatMap((e) => (e.type === 'state' ? [e.state] : []));
  return { browser, dispatcher, events, call, states };
}

const contact = { firstName: 'John', lastName: 'Smith', emailAddress: 'john@example.com' };

describe('ToolDispatcher', () => {
  it('runs the happy path through the state machine (design §3)', async () => {
    const { call, states, browser } = setup();

    expect(await call('openCreateContactForm')).toEqual({ ok: true, state: 'form_open', hash: '#Contact/create' });
    expect(await call('fillContactFields', contact)).toMatchObject({ ok: true, state: 'filling', values: contact });
    expect(await call('requestConfirmation')).toMatchObject({ ok: true, state: 'awaiting_confirmation', values: contact });
    const saved = await call('saveContact', { confirmed: true });

    expect(saved).toMatchObject({ ok: true, state: 'saved', id: 'abc123', hash: '#Contact/view/abc123' });
    expect(states()).toEqual(['form_open', 'filling', 'awaiting_confirmation', 'saving', 'saved']);
    expect(browser.clickSave).toHaveBeenCalledTimes(1);
  });

  it('rejects saveContact without a confirmation snapshot (R5.3)', async () => {
    const { call, browser } = setup();
    await call('openCreateContactForm');
    await call('fillContactFields', contact);

    const result = await call('saveContact', { confirmed: true });
    expect(result).toMatchObject({ ok: false, state: 'filling', error: expect.stringContaining('requestConfirmation') as string });
    expect(browser.clickSave).not.toHaveBeenCalled();
  });

  it('rejects saveContact with confirmed: false', async () => {
    const { call, browser } = setup();
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');

    expect(await call('saveContact', { confirmed: false })).toMatchObject({ ok: false });
    expect(browser.clickSave).not.toHaveBeenCalled();
  });

  it('invalidates the snapshot when a field changes after confirmation (R5.4)', async () => {
    const { call, browser } = setup();
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');
    expect(await call('fillContactFields', { emailAddress: 'j.smith@example.com' })).toMatchObject({ state: 'filling' });

    expect(await call('saveContact', { confirmed: true })).toMatchObject({ ok: false });
    expect(browser.clickSave).not.toHaveBeenCalled();

    await call('requestConfirmation');
    expect(await call('saveContact', { confirmed: true })).toMatchObject({ ok: true, state: 'saved' });
  });

  it('rejects the save if the DOM changed behind the snapshot', async () => {
    const { call, browser } = setup();
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');
    // E.g. the user typed into the form directly; no fillContactFields went through the dispatcher.
    await browser.fillContactFields({ lastName: 'Smyth' });

    expect(await call('saveContact', { confirmed: true })).toEqual({
      ok: false,
      state: 'awaiting_confirmation',
      error: 'form changed since confirmation',
    });
    expect(browser.clickSave).not.toHaveBeenCalled();
  });

  it('requires lastName for requestConfirmation (R4.3)', async () => {
    const { call } = setup();
    await call('openCreateContactForm');
    await call('fillContactFields', { firstName: 'John' });

    expect(await call('requestConfirmation')).toMatchObject({ ok: false, error: expect.stringContaining('lastName') as string });
  });

  it('returns validation errors to the model instead of throwing', async () => {
    const { call, browser } = setup();
    expect(await call('fillContactFields', { emailAddress: 'not an email' })).toMatchObject({ ok: false, state: 'idle' });
    expect(await call('fillContactFields', {})).toMatchObject({ ok: false });
    expect(await call('deleteEverything')).toMatchObject({ ok: false, error: 'Unknown tool: deleteEverything' });
    expect(browser.fillContactFields).not.toHaveBeenCalled();
  });

  it('waits for the user on a duplicate dialog, then creates on their decision (R8.1)', async () => {
    const { call, browser } = setup(['duplicate', 'saved']);
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');

    expect(await call('saveContact', { confirmed: true })).toMatchObject({ ok: true, state: 'duplicate_dialog', dialog: 'duplicate' });
    expect(browser.resolveDuplicate).not.toHaveBeenCalled();
    expect(await call('resolveDuplicate', { action: 'create' })).toMatchObject({ ok: true, state: 'saved', id: 'abc123' });
  });

  it('cancelling a duplicate keeps the form open and requires a fresh confirmation', async () => {
    const { call, browser } = setup(['duplicate']);
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');
    await call('saveContact', { confirmed: true });

    expect(await call('resolveDuplicate', { action: 'cancel' })).toMatchObject({ ok: true, state: 'form_open' });
    expect(await call('saveContact', { confirmed: true })).toMatchObject({ ok: false });
    expect(browser.clickSave).toHaveBeenCalledTimes(1);
  });

  it('refuses resolveDuplicate when no dialog is open', async () => {
    const { call, browser } = setup();
    expect(await call('resolveDuplicate', { action: 'create' })).toMatchObject({ ok: false });
    expect(browser.resolveDuplicate).not.toHaveBeenCalled();
  });

  it('goes back to filling when EspoCRM rejects the form', async () => {
    const { call } = setup(['invalid']);
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');

    expect(await call('saveContact', { confirmed: true })).toMatchObject({
      ok: false,
      state: 'filling',
      error: expect.stringContaining('Last Name is required') as string,
    });
  });

  it('lists, searches and opens existing contacts (R10)', async () => {
    const { call, browser } = setup();
    expect(await call('listContacts')).toMatchObject({ ok: true, state: 'idle', contacts: [existing], hasMore: false });
    expect(await call('listContacts', { search: 'Nobody' })).toMatchObject({ ok: true, contacts: [] });
    expect(browser.listContacts).toHaveBeenLastCalledWith('Nobody');

    expect(await call('openContact', { id: existing.id })).toEqual({
      ok: true,
      state: 'idle',
      hash: `#Contact/view/${existing.id}`,
      url: `https://crm.test/#Contact/view/${existing.id}`,
      contact: { id: existing.id, name: existing.name, emailAddress: existing.emailAddress, phoneNumber: existing.phoneNumber },
    });
    expect(await call('openContact', { id: 'nope' })).toMatchObject({ ok: false, state: 'idle' });
    expect(await call('openContact', { id: '../x' })).toMatchObject({ ok: false, error: expect.stringContaining('Invalid') as string });
  });

  it('refuses to browse away from a filled form and keeps the snapshot (R10.5)', async () => {
    const { call } = setup();
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');

    expect(await call('listContacts')).toMatchObject({ ok: false, state: 'awaiting_confirmation' });
    expect(await call('saveContact', { confirmed: true })).toMatchObject({ ok: true, state: 'saved' });
  });

  it('reports a browser that is not ready', async () => {
    const dispatcher = new ToolDispatcher({ getBrowser: () => null, onEvent: () => undefined });
    expect(await dispatcher.dispatch('c1', 'getScreenState', {})).toMatchObject({ ok: false });
  });
});

describe('Gemini tool call → dispatcher → tool response', () => {
  async function connected() {
    let params: LiveConnectParameters | undefined;
    const liveSession = {
      sendRealtimeInput: vi.fn<LiveSession['sendRealtimeInput']>(),
      sendClientContent: vi.fn<LiveSession['sendClientContent']>(),
      sendToolResponse: vi.fn<LiveSession['sendToolResponse']>(),
      close: vi.fn<LiveSession['close']>(),
    };
    const client: LiveClient = {
      connect(p) {
        params = p;
        return Promise.resolve(liveSession);
      },
    };
    const browser = fakeBrowser();
    const dispatcher = new ToolDispatcher({ getBrowser: () => browser, onEvent: () => undefined });
    const gemini = new GeminiSession({
      client,
      model: 'test-model',
      systemInstruction: 'test',
      tools: toolDeclarations(),
      onEvent: (event) => {
        if (event.type === 'toolCall') {
          void dispatcher.runCalls(event.calls).then((r) => {
            gemini.sendToolResponse(r);
          });
        }
        if (event.type === 'toolCancelled') dispatcher.cancel(event.ids);
      },
    });
    await gemini.start();
    if (params === undefined) throw new Error('not connected');
    const { callbacks, config } = params;
    const toolCall = (functionCalls: { id: string; name: string; args: Record<string, unknown> }[]) => {
      callbacks.onmessage(Object.assign(new LiveServerMessage(), { toolCall: { functionCalls } }));
    };
    const cancel = (ids: string[]) => {
      callbacks.onmessage(Object.assign(new LiveServerMessage(), { toolCallCancellation: { ids } }));
    };
    return { liveSession, browser, config, toolCall, cancel };
  }

  it('declares the tools in the Live config', async () => {
    const { config } = await connected();
    expect(JSON.stringify(config?.tools)).toContain('"name":"saveContact"');
  });

  it('answers a tool call with the dispatcher result', async () => {
    const { liveSession, toolCall } = await connected();
    toolCall([
      { id: 't1', name: 'openCreateContactForm', args: {} },
      { id: 't2', name: 'fillContactFields', args: { lastName: 'Smith' } },
    ]);

    await vi.waitFor(() => {
      expect(liveSession.sendToolResponse).toHaveBeenCalledTimes(1);
    });
    expect(liveSession.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        { id: 't1', name: 'openCreateContactForm', response: { ok: true, state: 'form_open', hash: '#Contact/create' } },
        {
          id: 't2',
          name: 'fillContactFields',
          response: {
            ok: true,
            state: 'filling',
            values: { ...EMPTY_CONTACT_VALUES, lastName: 'Smith' },
            changed: { lastName: { from: '', to: 'Smith' } },
          },
        },
      ],
    });
  });

  it('a save without a snapshot is answered with an error and nothing is clicked', async () => {
    const { liveSession, browser, toolCall } = await connected();
    toolCall([{ id: 't1', name: 'openCreateContactForm', args: {} }]);
    toolCall([{ id: 't2', name: 'saveContact', args: { confirmed: true } }]);

    await vi.waitFor(() => {
      expect(liveSession.sendToolResponse).toHaveBeenCalledTimes(2);
    });
    const response = liveSession.sendToolResponse.mock.calls[1]?.[0].functionResponses;
    expect(response).toMatchObject([{ id: 't2', name: 'saveContact', response: { ok: false } }]);
    expect(browser.clickSave).not.toHaveBeenCalled();
  });

  it('a cancelled save is not clicked and gets no response', async () => {
    const { liveSession, browser, toolCall, cancel } = await connected();
    toolCall([
      { id: 't1', name: 'openCreateContactForm', args: {} },
      { id: 't2', name: 'fillContactFields', args: { lastName: 'Smith' } },
      { id: 't3', name: 'requestConfirmation', args: {} },
    ]);
    await vi.waitFor(() => {
      expect(liveSession.sendToolResponse).toHaveBeenCalledTimes(1);
    });
    // Barge-in: Gemini cancels the save before the dispatcher reaches the click.
    toolCall([{ id: 't4', name: 'saveContact', args: { confirmed: true } }]);
    cancel(['t4']);
    await new Promise((r) => setTimeout(r, 20));

    expect(browser.clickSave).not.toHaveBeenCalled();
    expect(liveSession.sendToolResponse).toHaveBeenCalledTimes(1);
  });
});

describe('Barge-in & cancellation (R7)', () => {
  function queued() {
    const { browser, dispatcher, events, call } = setup();
    const run = (id: string, name: string, args: Record<string, unknown> = {}) =>
      dispatcher.runCalls([{ id, name, args }]);
    return { browser, dispatcher, events, call, run };
  }

  it('a cancellation that arrives while the save runs, before the click, aborts it (R7.2)', async () => {
    const { browser, dispatcher, events, call, run } = queued();
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');
    // Cancel while saveContact awaits its DOM read, i.e. before clickSave.
    browser.getScreenState.mockImplementationOnce(() => {
      dispatcher.cancel(['s1']);
      return Promise.resolve<ScreenState>({
        hash: '#Contact/create',
        view: 'contactCreate',
        values: { ...EMPTY_CONTACT_VALUES, ...contact },
        dialog: null,
      });
    });

    expect(await run('s1', 'saveContact', { confirmed: true })).toEqual([]);
    expect(browser.clickSave).not.toHaveBeenCalled();
    expect(dispatcher.currentState).toBe('awaiting_confirmation');
    expect(events.at(-1)).toMatchObject({ type: 'toolResult', id: 's1', result: { ok: false, error: expect.stringMatching(/cancelled/) } });
  });

  it('a cancellation after Save was clicked does not undo it and is reported as a late result', async () => {
    const { browser, dispatcher, events, call, run } = queued();
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');
    browser.clickSave.mockImplementationOnce(() => {
      dispatcher.cancel(['s1']);
      return Promise.resolve({ kind: 'saved', record: { id: 'abc123', hash: '#Contact/view/abc123', url: 'https://crm.test/#Contact/view/abc123', name: 'John Smith', emailAddress: contact.emailAddress, phoneNumber: '' } });
    });

    expect(await run('s1', 'saveContact', { confirmed: true })).toEqual([]);
    expect(dispatcher.currentState).toBe('saved');
    expect(events.at(-1)).toMatchObject({ type: 'cancelledAfterEffect', id: 's1', result: { ok: true, id: 'abc123' } });
  });

  it('idempotent tools finish and are answered normally after a cancellation', async () => {
    const { browser, run, dispatcher } = queued();
    await run('o1', 'openCreateContactForm');
    const pending = run('f1', 'fillContactFields', { lastName: 'Smith' });
    dispatcher.cancel(['f1']);
    expect(await pending).toEqual([]);
    expect(browser.fillContactFields).toHaveBeenCalledWith({ lastName: 'Smith' });
  });

  it('a cancelled fill that already ran is reported, so the model knows the screen changed (R7.5)', async () => {
    const { events, run, dispatcher } = queued();
    await run('o1', 'openCreateContactForm');
    const pending = run('f1', 'fillContactFields', { lastName: 'Smith' });
    dispatcher.cancel(['f1']);
    expect(await pending).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'cancelledAfterEffect',
      id: 'f1',
      name: 'fillContactFields',
      result: { ok: true, values: { lastName: 'Smith' } },
    });
  });

  it('a cancelled read-only call is not reported', async () => {
    const { events, run, dispatcher } = queued();
    const pending = run('g1', 'getScreenState');
    dispatcher.cancel(['g1']);
    expect(await pending).toEqual([]);
    expect(events.some((e) => e.type === 'cancelledAfterEffect')).toBe(false);
  });

  it('ignores cancellations for calls that were already answered', async () => {
    const { dispatcher, run } = queued();
    await run('o1', 'openCreateContactForm');
    dispatcher.cancel(['o1']);
    const responses = await run('o1', 'openCreateContactForm');
    expect(responses).toHaveLength(1);
  });

  it('correction after an interrupted read-back: snapshot cleared, fresh read-back, then save (R7.3)', async () => {
    const { browser, call, run, dispatcher } = queued();
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');
    // User barges in mid read-back; Gemini cancels the save it had already queued.
    const save = run('s1', 'saveContact', { confirmed: true });
    dispatcher.cancel(['s1']);
    expect(await save).toEqual([]);

    const fixed = 'jon.smith@example.com';
    expect(await call('fillContactFields', { emailAddress: fixed })).toMatchObject({ ok: true, state: 'filling' });
    expect(browser.fillContactFields).toHaveBeenLastCalledWith({ emailAddress: fixed });
    expect(await call('saveContact', { confirmed: true })).toMatchObject({ ok: false, error: expect.stringMatching(/confirm/i) });
    expect(browser.clickSave).not.toHaveBeenCalled();

    expect(await call('requestConfirmation')).toMatchObject({ ok: true, values: { ...contact, emailAddress: fixed } });
    expect(await call('saveContact', { confirmed: true })).toMatchObject({ ok: true, state: 'saved', values: { emailAddress: fixed } });
    expect(browser.clickSave).toHaveBeenCalledTimes(1);
  });
});

describe('Accurate explanations (R6.3, R7.4)', () => {
  it('fillContactFields reports exactly which fields changed, old → new', async () => {
    const { call } = setup();
    await call('openCreateContactForm');
    expect(await call('fillContactFields', contact)).toMatchObject({
      changed: { firstName: { from: '', to: 'John' }, lastName: { from: '', to: 'Smith' } },
    });
    const result = await call('fillContactFields', { firstName: 'Jon', lastName: 'Smith' });
    expect(result).toMatchObject({ ok: true, changed: { firstName: { from: 'John', to: 'Jon' } } });
    expect(result).not.toHaveProperty('changed.lastName');
  });

  it('save and open results carry the record url', async () => {
    const { call } = setup();
    await call('openCreateContactForm');
    await call('fillContactFields', contact);
    await call('requestConfirmation');
    expect(await call('saveContact', { confirmed: true })).toMatchObject({
      ok: true,
      url: 'https://crm.test/#Contact/view/abc123',
    });
    expect(await call('openContact', { id: existing.id })).toMatchObject({
      ok: true,
      url: `https://crm.test/#Contact/view/${existing.id}`,
      contact: { id: existing.id, name: existing.name },
    });
  });
});
