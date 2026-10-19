import { describe, it, expect } from 'vitest';
import { normalizeVersionTag, normalizeVersionTagOr, cleanVersionNumber } from './version.utils';

describe('version.utils', () => {
  describe('normalizeVersionTag', () => {
    it('returns v0.0.0 for empty or whitespace-only inputs', () => {
      expect(normalizeVersionTag(null)).toBe('v0.0.0');
      expect(normalizeVersionTag(undefined)).toBe('v0.0.0');
      expect(normalizeVersionTag('')).toBe('v0.0.0');
      expect(normalizeVersionTag('   ')).toBe('v0.0.0');
    });

    it('ensures single v prefix even with multiple leading vs', () => {
      expect(normalizeVersionTag('0.9.8')).toBe('v0.9.8');
      expect(normalizeVersionTag('v0.9.8')).toBe('v0.9.8');
      expect(normalizeVersionTag('vv0.9.8')).toBe('v0.9.8');
      expect(normalizeVersionTag('V0.9.8')).toBe('v0.9.8');
      expect(normalizeVersionTag('VV0.9.8')).toBe('v0.9.8');
    });

    it('trims whitespace', () => {
      expect(normalizeVersionTag('  0.9.8  ')).toBe('v0.9.8');
      expect(normalizeVersionTag('  v0.9.8  ')).toBe('v0.9.8');
    });
  });

  describe('normalizeVersionTagOr', () => {
    it('returns fallback for empty inputs', () => {
      expect(normalizeVersionTagOr(null, '—')).toBe('—');
      expect(normalizeVersionTagOr(undefined, '—')).toBe('—');
      expect(normalizeVersionTagOr('', '—')).toBe('—');
      expect(normalizeVersionTagOr('   ', '—')).toBe('—');
    });

    it('returns normalized tag when present', () => {
      expect(normalizeVersionTagOr('0.9.8', '—')).toBe('v0.9.8');
      expect(normalizeVersionTagOr('v0.9.8', '—')).toBe('v0.9.8');
      expect(normalizeVersionTagOr('vv0.9.8', '—')).toBe('v0.9.8');
    });
  });

  describe('cleanVersionNumber', () => {
    it('returns 0.0.0 for empty inputs', () => {
      expect(cleanVersionNumber(null)).toBe('0.0.0');
      expect(cleanVersionNumber(undefined)).toBe('0.0.0');
      expect(cleanVersionNumber('')).toBe('0.0.0');
    });

    it('strips all leading vs', () => {
      expect(cleanVersionNumber('0.9.8')).toBe('0.9.8');
      expect(cleanVersionNumber('v0.9.8')).toBe('0.9.8');
      expect(cleanVersionNumber('vv0.9.8')).toBe('0.9.8');
      expect(cleanVersionNumber('V0.9.8')).toBe('0.9.8');
    });
  });
});
