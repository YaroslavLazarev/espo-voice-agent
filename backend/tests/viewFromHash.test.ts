import { describe, expect, it } from 'vitest';
import { viewFromHash } from '../src/browser/BrowserController.ts';

describe('viewFromHash', () => {
  it.each([
    ['', false, 'other'],
    ['#Contact', false, 'contactList'],
    ['#Contact/list', false, 'contactList'],
    ['#Contact/create', false, 'contactCreate'],
    ['#Contact/view/abc123', false, 'contactView'],
    ['#Contact/edit/abc123', false, 'other'],
    ['#Account', false, 'other'],
    ['', true, 'login'],
  ] as const)('%s (login=%s) -> %s', (hash, login, view) => {
    expect(viewFromHash(hash, login)).toBe(view);
  });
});
