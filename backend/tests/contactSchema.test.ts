import { describe, expect, it } from 'vitest';
import { contactFieldsInputSchema } from '../src/schemas/contact.ts';

describe('contactFieldsInputSchema', () => {
  it('accepts a partial update', () => {
    expect(contactFieldsInputSchema.parse({ firstName: ' John ' })).toEqual({ firstName: 'John' });
  });

  it('accepts all fields', () => {
    const input = {
      salutation: 'Dr.',
      firstName: 'Jane',
      lastName: 'Doe',
      emailAddress: 'jane@example.com',
      phoneNumber: '+1 (555) 000-1111',
    };
    expect(contactFieldsInputSchema.parse(input)).toEqual(input);
  });

  it('allows clearing optional fields with an empty string', () => {
    expect(contactFieldsInputSchema.parse({ emailAddress: '', salutation: '', phoneNumber: '' })).toEqual({
      emailAddress: '',
      salutation: '',
      phoneNumber: '',
    });
  });

  it.each([
    ['empty object', {}],
    ['empty lastName', { lastName: '  ' }],
    ['bad email', { emailAddress: 'john at example' }],
    ['bad salutation', { salutation: 'Sir' }],
    ['letters in phone', { phoneNumber: 'call me' }],
    ['unknown field', { firstName: 'A', accountName: 'X' }],
    ['too long name', { firstName: 'x'.repeat(101) }],
  ])('rejects %s', (_name, input) => {
    expect(contactFieldsInputSchema.safeParse(input).success).toBe(false);
  });
});
