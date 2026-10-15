import { describe, it, expect } from 'vitest';
import { compareVersions } from './versioning';

describe('compareVersions (semver desc)', () => {
  it('ordena mayor/minor/patch numéricamente', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0); // no lexicográfico
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
  });

  it('es consistente con .sort() descendente', () => {
    const versions = ['0.1.0', '0.10.0', '0.2.0', '1.0.0'];
    const sorted = [...versions].sort((a, b) => compareVersions(b, a));
    expect(sorted).toEqual(['1.0.0', '0.10.0', '0.2.0', '0.1.0']);
  });

  it('trata versiones incompletas como 0', () => {
    expect(compareVersions('0.2', '0.2.0')).toBe(0);
    expect(compareVersions('1', '1.0.0')).toBe(0);
  });

  it('listTemplateCommits y resolveTemplateRef están exportadas', async () => {
    const mod = await import('./versioning');
    expect(typeof mod.listTemplateCommits).toBe('function');
    expect(typeof mod.resolveTemplateRef).toBe('function');
  });

  it('permite limpiar la cache de versiones', async () => {
    const { _clearTemplateVersionsCache } = await import('./versioning');
    expect(typeof _clearTemplateVersionsCache).toBe('function');
    expect(() => _clearTemplateVersionsCache()).not.toThrow();
  });
});
