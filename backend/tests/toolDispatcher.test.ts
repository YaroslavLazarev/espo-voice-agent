import { LiveServerMessage, type LiveConnectParameters } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { GeminiSession, type LiveClient, type LiveSession } from '../src/agent/GeminiSession.ts';
import { ToolDispatcher, type ContactBrowser, type DispatcherEvent } from '../src/agent/ToolDispatcher.ts';
import type { SaveOutcome, ScreenState } from '../src/browser/BrowserController.ts';
import { EMPTY_CONTACT_VALUES, type ContactValues } from '../src/schemas/contact.ts';
import { toolDeclarations } from '../src/schemas/tools.ts';

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
    return { kind, record: { id: 'abc123', hash, name, emailAddress: values.emailAddress, phoneNumber: values.phoneNumber } };
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
          response: { ok: true, state: 'filling', values: { ...EMPTY_CONTACT_VALUES, lastName: 'Smith' } },
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
