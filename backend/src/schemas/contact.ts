import { z } from 'zod';

export const SALUTATIONS = ['Mr.', 'Ms.', 'Mrs.', 'Dr.'] as const;

export const CONTACT_FIELDS = ['salutation', 'firstName', 'lastName', 'emailAddress', 'phoneNumber'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

/** Current values of the supported form fields. An empty string means the field is blank. */
export const contactValuesSchema = z.object({
  salutation: z.union([z.literal(''), z.enum(SALUTATIONS)]),
  firstName: z.string(),
  lastName: z.string(),
  emailAddress: z.string(),
  phoneNumber: z.string(),
});
export type ContactValues = z.infer<typeof contactValuesSchema>;

export const EMPTY_CONTACT_VALUES: ContactValues = {
  salutation: '',
  firstName: '',
  lastName: '',
  emailAddress: '',
  phoneNumber: '',
};

/**
 * Partial update of the form. Only provided fields change; an empty string clears a field
 * (except `lastName`, which is required by EspoCRM).
 */
export const contactFieldsInputSchema = z
  .object({
    salutation: z.union([z.literal(''), z.enum(SALUTATIONS)]).describe('Mr., Ms., Mrs., Dr., or empty to clear'),
    firstName: z.string().trim().max(100).describe('first name'),
    lastName: z.string().trim().min(1, 'lastName cannot be empty').max(100).describe('last name (required)'),
    emailAddress: z
      .union([z.literal(''), z.email('emailAddress must be a valid email').max(255)])
      .describe('primary email address, lowercase, e.g. john.smith@example.com'),
    phoneNumber: z
      .string()
      .trim()
      .max(36)
      .regex(/^[+\d\s().-]*$/, 'phoneNumber may contain only digits, spaces, + ( ) . -')
      .describe('primary phone number, digits with an optional leading +'),
  })
  .partial()
  .strict()
  .refine((fields) => Object.values(fields).some((v) => v !== undefined), {
    error: 'Provide at least one field',
  });
export type ContactFieldsInput = z.infer<typeof contactFieldsInputSchema>;

/** EspoCRM record id, e.g. `67d18fd9385c09281`. Alphanumeric only, so it is safe inside CSS selectors. */
export const contactIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,64}$/, 'id must be a contact id returned by listContacts');

/** One row of the Contacts list, as read from the DOM. */
export const contactListRowSchema = z.object({
  id: contactIdSchema,
  name: z.string(),
  account: z.string(),
  emailAddress: z.string(),
  phoneNumber: z.string(),
});
export type ContactListRow = z.infer<typeof contactListRowSchema>;
