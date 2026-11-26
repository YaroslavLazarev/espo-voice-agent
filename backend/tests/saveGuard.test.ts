import { describe, expect, it } from 'vitest';
import { hashValues, SaveGuard } from '../src/agent/saveGuard.ts';
import { EMPTY_CONTACT_VALUES, type ContactValues } from '../src/schemas/contact.ts';

const values: ContactValues = {
  ...EMPTY_CONTACT_VALUES,
  salutation: 'Mr.',
  firstName: 'John',
  lastName: 'Smith',
  emailAddress: 'john@example.com',
  phoneNumber: '+15550001111',
};

describe('SaveGuard', () => {
  it('rejects when not confirmed', () => {
    const guard = new SaveGuard();
    guard.snapshot(values);
    expect(guard.check(false, values)).toEqual({ ok: false, error: expect.stringContaining('confirmed: true') });
  });

  it('rejects without a snapshot', () => {
    expect(new SaveGuard().check(true, values)).toEqual({
      ok: false,
      error: expect.stringContaining('requestConfirmation'),
    });
  });

  it('accepts when the form matches the snapshot', () => {
    const guard = new SaveGuard();
    guard.snapshot(values);
    expect(guard.check(true, values)).toEqual({ ok: true });
  });

  it.each<[string, Partial<ContactValues>]>([
    ['salutation', { salutation: 'Dr.' }],
    ['firstName', { firstName: 'Jon' }],
    ['lastName', { lastName: 'Smyth' }],
    ['emailAddress', { emailAddress: 'jon@example.com' }],
    ['phoneNumber', { phoneNumber: '+15550002222' }],
  ])('rejects after %s changed', (_field, change) => {
    const guard = new SaveGuard();
    guard.snapshot(values);
    expect(guard.check(true, { ...values, ...change })).toEqual({
      ok: false,
      error: 'form changed since confirmation',
    });
  });

  it('rejects after clear()', () => {
    const guard = new SaveGuard();
    guard.snapshot(values);
    guard.clear();
    expect(guard.hasSnapshot).toBe(false);
    expect(guard.check(true, values).ok).toBe(false);
  });

  it('ignores whitespace and email case', () => {
    const guard = new SaveGuard();
    guard.snapshot(values);
    expect(
      guard.check(true, { ...values, firstName: ' John ', emailAddress: 'JOHN@Example.com ' }),
    ).toEqual({ ok: true });
  });

  it('does not confuse values across fields', () => {
    expect(hashValues({ ...EMPTY_CONTACT_VALUES, firstName: 'A', lastName: '' })).not.toBe(
      hashValues({ ...EMPTY_CONTACT_VALUES, firstName: '', lastName: 'A' }),
    );
  });
});
