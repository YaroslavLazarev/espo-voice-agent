/**
 * Agent tool argument schemas (specs/design.md §4). The same zod schemas validate the
 * model's arguments at runtime and generate the Gemini function declarations.
 */
import type { FunctionDeclaration } from '@google/genai';
import { z } from 'zod';
import { contactFieldsInputSchema } from './contact.ts';

const noArgs = z.object({}).strict();

export const toolSchemas = {
  navigateToContacts: {
    description: 'Open the Contacts list in EspoCRM. Fails if the create form has unsaved values.',
    args: noArgs,
  },
  openCreateContactForm: {
    description: 'Open the "create Contact" form. No-op if it is already open.',
    args: noArgs,
  },
  fillContactFields: {
    description:
      'Type values into the open create form. Only the given fields change; others are kept. ' +
      'An empty string clears an optional field. Invalidates any previous confirmation.',
    args: contactFieldsInputSchema,
  },
  getScreenState: {
    description: 'Read the live screen: URL hash, current form values, and whether a duplicate dialog is open.',
    args: noArgs,
  },
  requestConfirmation: {
    description:
      'Take a snapshot of the current form values (lastName required) before saving. ' +
      'Then read ALL returned values back to the user (spell emails letter by letter) and wait for an explicit yes.',
    args: noArgs,
  },
  saveContact: {
    description:
      'Click Save. Only after the user explicitly confirmed the latest read-back. ' +
      'Rejected if the form changed since requestConfirmation.',
    args: z
      .object({ confirmed: z.boolean().describe('true only if the user explicitly said yes to the read-back') })
      .strict(),
  },
  resolveDuplicate: {
    description:
      'Answer the EspoCRM "possible duplicate" dialog. Only after the user chose: create anyway, or cancel.',
    args: z.object({ action: z.enum(['create', 'cancel']).describe('the user decision') }).strict(),
  },
  cancelForm: {
    description: 'Discard the create form (only after the user agreed to drop the entered values).',
    args: noArgs,
  },
} as const;

export type ToolName = keyof typeof toolSchemas;
export const TOOL_NAMES = Object.keys(toolSchemas) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(toolSchemas, name);
}

/** JSON Schema keywords the Gemini function-calling subset understands; others are dropped. */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'description',
  'enum',
  'items',
  'anyOf',
  'properties',
  'required',
  'additionalProperties',
  'maxLength',
  'minLength',
]);

/** Keeps the supported subset: drops `$schema`, `format`, `pattern`; turns `const` into a one-value `enum`. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'const') out.enum = [value];
    else if (key === 'properties' && typeof value === 'object' && value !== null) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (ALLOWED_KEYWORDS.has(key)) out[key] = toGeminiSchema(value);
  }
  return out;
}

export function toolDeclarations(): FunctionDeclaration[] {
  return TOOL_NAMES.map((name) => {
    const { description, args } = toolSchemas[name];
    if (Object.keys(args.shape).length === 0) return { name, description };
    return { name, description, parametersJsonSchema: toGeminiSchema(z.toJSONSchema(args, { io: 'input' })) };
  });
}
