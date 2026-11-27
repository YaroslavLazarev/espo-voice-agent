import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, toGeminiSchema, toolDeclarations, toolSchemas } from '../src/schemas/tools.ts';

describe('tool schemas', () => {
  it('declares every tool from design §4', () => {
    expect(TOOL_NAMES).toEqual([
      'navigateToContacts',
      'openCreateContactForm',
      'fillContactFields',
      'getScreenState',
      'requestConfirmation',
      'saveContact',
      'resolveDuplicate',
      'cancelForm',
      'listContacts',
      'openContact',
    ]);
  });

  it('validates listContacts and openContact args', () => {
    expect(toolSchemas.listContacts.args.safeParse({}).success).toBe(true);
    expect(toolSchemas.listContacts.args.safeParse({ search: 'Smith' }).success).toBe(true);
    expect(toolSchemas.listContacts.args.safeParse({ search: 1 }).success).toBe(false);
    expect(toolSchemas.openContact.args.safeParse({ id: '67d18fd9385c09281' }).success).toBe(true);
    expect(toolSchemas.openContact.args.safeParse({}).success).toBe(false);
    // Ids end up inside a CSS selector: anything but alphanumerics is rejected.
    expect(toolSchemas.openContact.args.safeParse({ id: 'a"] , body' }).success).toBe(false);
  });

  it('validates saveContact and resolveDuplicate args', () => {
    expect(toolSchemas.saveContact.args.safeParse({ confirmed: true }).success).toBe(true);
    expect(toolSchemas.saveContact.args.safeParse({}).success).toBe(false);
    expect(toolSchemas.saveContact.args.safeParse({ confirmed: 'yes' }).success).toBe(false);
    expect(toolSchemas.resolveDuplicate.args.safeParse({ action: 'create' }).success).toBe(true);
    expect(toolSchemas.resolveDuplicate.args.safeParse({ action: 'merge' }).success).toBe(false);
    expect(toolSchemas.getScreenState.args.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('turns const into enum and drops unsupported keywords', () => {
    expect(
      toGeminiSchema({
        $schema: 'x',
        type: 'object',
        properties: { a: { anyOf: [{ type: 'string', const: '' }, { type: 'string', format: 'email', pattern: '.' }] } },
      }),
    ).toEqual({ type: 'object', properties: { a: { anyOf: [{ type: 'string', enum: [''] }, { type: 'string' }] } } });
  });

  it('generates Gemini function declarations from the zod schemas', () => {
    const declarations = toolDeclarations();
    expect(declarations.map((d) => d.name)).toEqual(TOOL_NAMES);
    for (const d of declarations) expect(d.description).toBeTruthy();

    const byName = Object.fromEntries(declarations.map((d) => [d.name, d]));
    expect(byName.getScreenState?.parametersJsonSchema).toBeUndefined();
    expect(byName.saveContact?.parametersJsonSchema).toMatchObject({
      type: 'object',
      properties: { confirmed: { type: 'boolean' } },
      required: ['confirmed'],
    });
    const fill = JSON.stringify(byName.fillContactFields?.parametersJsonSchema);
    for (const field of ['salutation', 'firstName', 'lastName', 'emailAddress', 'phoneNumber']) expect(fill).toContain(field);
    expect(fill).toContain('"Dr."');
    expect(fill).not.toMatch(/"(\$schema|const|format|pattern)"/);
  });
});
