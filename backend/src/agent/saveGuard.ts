import { createHash } from 'node:crypto';
import { CONTACT_FIELDS, type ContactValues } from '../schemas/contact.ts';

export function normalizeValues(values: ContactValues): ContactValues {
  return {
    salutation: values.salutation,
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    emailAddress: values.emailAddress.trim().toLowerCase(),
    phoneNumber: values.phoneNumber.trim(),
  };
}

export function hashValues(values: ContactValues): string {
  const normalized = normalizeValues(values);
  const ordered = CONTACT_FIELDS.map((field) => [field, normalized[field]]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export type GuardCheck = { ok: true } | { ok: false; error: string };

/**
 * Enforces "never save without confirmation" in code (CLAUDE.md, specs/design.md §4).
 * `snapshot` is taken when the agent reads values back; any fill clears it; `check`
 * compares the live form against the snapshot right before Save.
 */
export class SaveGuard {
  #snapshotHash: string | null = null;

  get hasSnapshot(): boolean {
    return this.#snapshotHash !== null;
  }

  snapshot(values: ContactValues): void {
    this.#snapshotHash = hashValues(values);
  }

  clear(): void {
    this.#snapshotHash = null;
  }

  check(confirmed: boolean, currentValues: ContactValues): GuardCheck {
    if (!confirmed) {
      return { ok: false, error: 'saveContact requires confirmed: true after the user explicitly confirms' };
    }
    if (this.#snapshotHash === null) {
      return { ok: false, error: 'no confirmed values: call requestConfirmation and read the values back first' };
    }
    if (hashValues(currentValues) !== this.#snapshotHash) {
      return { ok: false, error: 'form changed since confirmation' };
    }
    return { ok: true };
  }
}
