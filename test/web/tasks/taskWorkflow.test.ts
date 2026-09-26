import { setFlag } from '../../../src/web/features/settings/model/draft';
import {
  hasOwnSettings,
  sameSettings,
  settingsRequest,
} from '../../../src/web/features/tasks/model/taskWorkflow';

describe('what a task stores about its AI workflow', () => {
  describe('hasOwnSettings', () => {
    it('is false for a task that says nothing, and for an empty object left in the file', () => {
      expect(hasOwnSettings(undefined)).toBe(false);
      expect(hasOwnSettings({})).toBe(false);
    });

    it('is true for any setting, and "off" is a setting like any other (INVARIANT)', () => {
      expect(hasOwnSettings({ push: true })).toBe(true);
      expect(hasOwnSettings({ push: false })).toBe(true);
      expect(hasOwnSettings({ editCode: false, report: true })).toBe(true);
    });
  });

  describe('settingsRequest', () => {
    it('sends null when nothing is left, never an empty object (INVARIANT)', () => {
      expect(settingsRequest({})).toBeNull();
    });

    it('sends what is set, whole, and keeps an "off" (INVARIANT)', () => {
      expect(settingsRequest({ push: false })).toEqual({ push: false });
      expect(settingsRequest({ push: true, report: false })).toEqual({ push: true, report: false });
    });

    it('does not hand out the draft itself', () => {
      const draft = { push: true };
      expect(settingsRequest(draft)).not.toBe(draft);
    });
  });

  describe('sameSettings', () => {
    it('does not tell "no overrides" from an empty object, or one key order from another', () => {
      expect(sameSettings(undefined, {})).toBe(true);
      expect(sameSettings({ push: true, report: false }, { report: false, push: true })).toBe(true);
    });

    it('tells one value from another, and off from nothing', () => {
      expect(sameSettings({ push: true }, { push: false })).toBe(false);
      expect(sameSettings({ push: false }, {})).toBe(false);
      expect(sameSettings({ push: false }, undefined)).toBe(false);
    });
  });
});

describe('setFlag', () => {
  it('sets on and off', () => {
    expect(setFlag({}, 'push', true)).toEqual({ push: true });
    expect(setFlag({ push: true }, 'push', false)).toEqual({ push: false });
  });

  it('takes the key out for "inherit", and leaves the others', () => {
    expect(setFlag({ push: true, report: false }, 'push', 'inherit')).toEqual({ report: false });
    expect(setFlag({ push: true }, 'push', 'inherit')).toEqual({});
  });

  it('does not change what it was given', () => {
    const flags = Object.freeze({ push: true });
    expect(() => setFlag(flags, 'report', false)).not.toThrow();
    expect(flags).toEqual({ push: true });
  });
});
