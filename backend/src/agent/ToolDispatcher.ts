import { FunctionResponse, type FunctionCall } from '@google/genai';
import type { AgentState } from '@espo/shared';
import { z } from 'zod';
import { BrowserActionError, type BrowserController, type SaveOutcome } from '../browser/BrowserController.ts';
import { isToolName, toolSchemas, type ToolName } from '../schemas/tools.ts';
import { SaveGuard } from './saveGuard.ts';

/** The browser methods the tools need; tests pass a fake. */
export type ContactBrowser = Pick<
  BrowserController,
  | 'navigateToContacts'
  | 'openCreateContactForm'
  | 'fillContactFields'
  | 'getScreenState'
  | 'clickSave'
  | 'resolveDuplicate'
  | 'cancelForm'
>;

export type ToolResult =
  | ({ ok: true; state: AgentState } & Record<string, unknown>)
  | { ok: false; state: AgentState; error: string };

export type DispatcherEvent =
  | { type: 'state'; state: AgentState }
  | { type: 'toolCall'; id: string; name: string; args: unknown }
  | { type: 'toolResult'; id: string; name: string; result: ToolResult }
  /** A cancelled call whose side effect already happened (Save was clicked); the model must be told. */
  | { type: 'cancelledAfterEffect'; id: string; name: string; result: ToolResult };

export interface ToolDispatcherOptions {
  /** `null` while the browser is still starting. */
  getBrowser: () => ContactBrowser | null;
  onEvent: (event: DispatcherEvent) => void;
}

type Data = Record<string, unknown>;

/** Thrown inside a tool to return `{ ok: false, error }`, optionally moving to another state. */
class ToolError extends Error {
  constructor(
    message: string,
    readonly nextState?: AgentState,
  ) {
    super(message);
  }
}

/**
 * Executes Gemini tool calls against the browser (specs/design.md §3–§4).
 * Owns the agent state machine and the save guard; knows nothing about WebSockets.
 * Calls run one at a time, since they all drive the same page.
 */
export class ToolDispatcher {
  private state: AgentState = 'idle';
  private readonly guard = new SaveGuard();
  private readonly cancelled = new Set<string>();
  /** Ids received but not answered yet; cancellations for other ids are ignored. */
  private readonly pending = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ToolDispatcherOptions) {}

  get currentState(): AgentState {
    return this.state;
  }

  /** Marks calls as cancelled (`toolCallCancellation`). A pending save checks this right before clicking. */
  cancel(ids: readonly string[]): void {
    for (const id of ids) if (this.pending.has(id)) this.cancelled.add(id);
  }

  /** Runs the calls in order and returns the responses for the non-cancelled ones. */
  runCalls(calls: readonly FunctionCall[]): Promise<FunctionResponse[]> {
    // Registered synchronously, so a cancellation that arrives while the calls wait in the queue counts.
    for (const call of calls) this.pending.add(call.id ?? '');
    const run = this.queue.then(async () => {
      const responses: FunctionResponse[] = [];
      for (const call of calls) {
        const id = call.id ?? '';
        const name = call.name ?? '';
        const result = await this.dispatch(id, name, call.args ?? {}).finally(() => this.pending.delete(id));
        if (this.cancelled.delete(id)) {
          // Gemini ignores responses to cancelled calls; a save that already went through must still be reported.
          if (name === 'saveContact' && result.ok) this.emit({ type: 'cancelledAfterEffect', id, name, result });
          continue;
        }
        responses.push(Object.assign(new FunctionResponse(), { id, name, response: result }));
      }
      return responses;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async dispatch(id: string, name: string, args: unknown): Promise<ToolResult> {
    this.emit({ type: 'toolCall', id, name, args });
    const result = await this.execute(id, name, args);
    this.emit({ type: 'toolResult', id, name, result });
    return result;
  }

  private async execute(id: string, name: string, args: unknown): Promise<ToolResult> {
    if (!isToolName(name)) return this.fail(`Unknown tool: ${name}`);
    const parsed = toolSchemas[name].args.safeParse(args);
    if (!parsed.success) return this.fail(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
    const browser = this.options.getBrowser();
    if (browser === null) return this.fail('The browser is not ready yet; try again in a moment');
    try {
      const data = await this.run(name, parsed.data, browser, id);
      return { ok: true, state: this.state, ...data };
    } catch (error) {
      if (error instanceof ToolError) return this.fail(error.message, error.nextState);
      if (error instanceof BrowserActionError) return this.fail(error.message);
      return this.fail(`Unexpected browser error: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async run(name: ToolName, args: unknown, browser: ContactBrowser, id: string): Promise<Data> {
    switch (name) {
      case 'navigateToContacts': {
        const result = await browser.navigateToContacts();
        this.guard.clear();
        this.setState('idle');
        return result;
      }
      case 'openCreateContactForm': {
        const result = await browser.openCreateContactForm();
        // Re-opening the already open form keeps filling / awaiting_confirmation.
        if (!(['filling', 'awaiting_confirmation'] as AgentState[]).includes(this.state)) this.setState('form_open');
        return result;
      }
      case 'fillContactFields': {
        const fields = toolSchemas.fillContactFields.args.parse(args);
        this.guard.clear();
        this.setState('filling');
        return { values: await browser.fillContactFields(fields) };
      }
      case 'getScreenState':
        return { ...(await browser.getScreenState()) };
      case 'requestConfirmation':
        return this.requestConfirmation(browser);
      case 'saveContact':
        return this.saveContact(toolSchemas.saveContact.args.parse(args).confirmed, browser, id);
      case 'resolveDuplicate':
        return this.resolveDuplicate(toolSchemas.resolveDuplicate.args.parse(args).action, browser);
      case 'cancelForm': {
        const result = await browser.cancelForm();
        this.guard.clear();
        this.setState('idle');
        return result;
      }
    }
  }

  private async requestConfirmation(browser: ContactBrowser): Promise<Data> {
    const { values } = await browser.getScreenState();
    if (values === null) throw new ToolError('The contact create form is not open');
    if (values.lastName.trim() === '') throw new ToolError('lastName is required: ask the user for the last name');
    this.guard.snapshot(values);
    this.setState('awaiting_confirmation');
    return {
      values,
      instruction: 'Read all these values back (spell the email letter by letter) and wait for an explicit yes.',
    };
  }

  private async saveContact(confirmed: boolean, browser: ContactBrowser, id: string): Promise<Data> {
    const { values } = await browser.getScreenState();
    if (values === null) throw new ToolError('The contact create form is not open');
    const check = this.guard.check(confirmed, values);
    if (!check.ok) throw new ToolError(check.error);
    // Last moment to honour a toolCallCancellation (barge-in): nothing has been clicked yet.
    if (this.cancelled.has(id)) throw new ToolError('save cancelled by the user before Save was clicked');
    this.setState('saving');
    const outcome = await browser.clickSave().catch((error: unknown) => {
      this.setState('filling');
      throw error;
    });
    return this.afterSave(outcome);
  }

  private async resolveDuplicate(action: 'create' | 'cancel', browser: ContactBrowser): Promise<Data> {
    if (this.state !== 'duplicate_dialog') throw new ToolError('No duplicate dialog is waiting for a decision');
    const outcome = await browser.resolveDuplicate(action);
    if (outcome.kind === 'cancelled') {
      this.guard.clear();
      this.setState('form_open');
      const { hash } = await browser.getScreenState();
      return { hash, note: 'Not saved. The form is still open; confirm again before saving.' };
    }
    return this.afterSave(outcome);
  }

  private afterSave(outcome: SaveOutcome): Data {
    switch (outcome.kind) {
      case 'saved':
        this.guard.clear();
        this.setState('saved');
        return { id: outcome.record.id, hash: outcome.record.hash, values: outcome.record };
      case 'duplicate':
        this.setState('duplicate_dialog');
        return {
          dialog: 'duplicate',
          instruction: 'EspoCRM says this contact might already exist. Ask the user: create anyway, or cancel?',
        };
      case 'invalid':
        this.guard.clear();
        throw new ToolError(`EspoCRM rejected the form: ${outcome.errors.join('; ')}`, 'filling');
    }
  }

  private fail(error: string, nextState?: AgentState): ToolResult {
    if (nextState !== undefined) this.setState(nextState);
    return { ok: false, state: this.state, error };
  }

  private setState(state: AgentState): void {
    if (state === this.state) return;
    this.state = state;
    this.emit({ type: 'state', state });
  }

  private emit(event: DispatcherEvent): void {
    this.options.onEvent(event);
  }
}
