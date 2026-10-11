import { describe, expect, it } from 'vitest';
import * as contactDetails from './index';

// What the integration mounts in the contactDetails slot of the shell (I6).
describe('the contact details module', () => {
  it('exports the panel', () => {
    expect(Object.keys(contactDetails)).toEqual(['ContactDetailsPanel']);
  });
});
