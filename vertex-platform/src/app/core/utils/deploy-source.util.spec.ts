import { describe, it, expect } from 'vitest';
import { STOREFRONT_REPO } from '@core/utils/deploy-source.util';
import {
  canDeployTestSources,
  deployChannelLabel,
  deploySourceCommitSuffix,
  deploySourceGitHubUrl,
  deploySourceLabel,
  deploySourceShortLabel,
  isStoreDevEnvironment,
  isTestDeploySource,
  validateDeploySourceValue,
} from '@core/utils/deploy-source.util';
import type { Store } from '@core/models/store';

const store = (partial: Partial<Store>): Store => ({ status: 'active', ...partial }) as Store;

describe('isStoreDevEnvironment', () => {
  it('detecta environment development', () => {
    expect(isStoreDevEnvironment(store({ environment: 'development' }))).toBe(true);
  });

  it('detecta projectId con -dev', () => {
    expect(isStoreDevEnvironment(store({ firebaseProjectId: 'vtx-x-dev' }))).toBe(true);
    expect(isStoreDevEnvironment(store({ runtimeProjectId: 'vtx-y-dev' }))).toBe(true);
  });

  it('no marca producción y tolera null', () => {
    expect(isStoreDevEnvironment(store({ firebaseProjectId: 'ecommerce-vertex' }))).toBe(false);
    expect(isStoreDevEnvironment(null)).toBe(false);
    expect(isStoreDevEnvironment(undefined)).toBe(false);
  });
});

describe('canDeployTestSources', () => {
  it('habilita dev y opt-in explícito', () => {
    expect(canDeployTestSources(store({ environment: 'development' }))).toBe(true);
    expect(canDeployTestSources(store({ allowTestDeployments: true }))).toBe(true);
  });

  it('bloquea producción sin opt-in', () => {
    expect(canDeployTestSources(store({}))).toBe(false);
    expect(canDeployTestSources(store({ allowTestDeployments: false }))).toBe(false);
    expect(canDeployTestSources(null)).toBe(false);
  });
});

describe('isTestDeploySource', () => {
  it('marca branch y commit como prueba', () => {
    expect(isTestDeploySource({ kind: 'branch', ref: 'develop' })).toBe(true);
    expect(isTestDeploySource({ kind: 'commit', ref: 'abc1234' })).toBe(true);
  });

  it('no marca release ni ausencia de fuente', () => {
    expect(isTestDeploySource({ kind: 'release', ref: 'v0.9.5' })).toBe(false);
    expect(isTestDeploySource(null)).toBe(false);
    expect(isTestDeploySource(undefined)).toBe(false);
  });
});

describe('deploySourceShortLabel / deploySourceLabel', () => {
  it('normaliza el prefijo v en releases', () => {
    expect(deploySourceShortLabel({ kind: 'release', ref: '0.9.5' })).toBe('v0.9.5');
    expect(deploySourceShortLabel({ kind: 'release', ref: 'v0.9.5' })).toBe('v0.9.5');
  });

  it('devuelve el ref tal cual en ramas y commits', () => {
    expect(deploySourceShortLabel({ kind: 'branch', ref: 'feat/x' })).toBe('feat/x');
    expect(deploySourceShortLabel({ kind: 'commit', ref: 'abc1234' })).toBe('abc1234');
  });

  it('cae a la versión de la tienda cuando no hay fuente', () => {
    expect(deploySourceShortLabel(undefined, '0.9.5')).toBe('v0.9.5');
    expect(deploySourceShortLabel(null, undefined)).toBe('—');
  });

  it('describe la fuente con su tipo', () => {
    expect(deploySourceLabel({ kind: 'release', ref: '0.9.5' })).toBe('Release v0.9.5');
    expect(deploySourceLabel({ kind: 'branch', ref: 'develop' })).toBe('Rama develop');
    expect(deploySourceLabel({ kind: 'commit', ref: 'abc1234' })).toBe('Commit abc1234');
    expect(deploySourceLabel(undefined, undefined)).toBe('—');
  });
});

describe('deploySourceCommitSuffix', () => {
  it('agrega el sha corto para pruebas', () => {
    expect(
      deploySourceCommitSuffix({ kind: 'branch', ref: 'develop', commitSha: 'abcdef1234' }),
    ).toBe(' @ abcdef1');
  });

  it('no agrega sufijo en releases ni sin sha', () => {
    expect(
      deploySourceCommitSuffix({ kind: 'release', ref: 'v0.9.5', commitSha: 'abcdef1234' }),
    ).toBe('');
    expect(deploySourceCommitSuffix({ kind: 'branch', ref: 'develop' })).toBe('');
    expect(deploySourceCommitSuffix(undefined)).toBe('');
  });
});

describe('deploySourceGitHubUrl', () => {
  it('apunta a la release, la rama o el commit', () => {
    expect(deploySourceGitHubUrl({ kind: 'release', ref: '0.9.5' })).toBe(
      `https://github.com/${STOREFRONT_REPO}/releases/tag/v0.9.5`,
    );
    expect(deploySourceGitHubUrl({ kind: 'branch', ref: 'feat/x' })).toBe(
      `https://github.com/${STOREFRONT_REPO}/tree/feat/x`,
    );
    expect(deploySourceGitHubUrl({ kind: 'commit', ref: 'abc1234' })).toBe(
      `https://github.com/${STOREFRONT_REPO}/commit/abc1234`,
    );
  });

  it('cae al repositorio si no hay ref', () => {
    expect(deploySourceGitHubUrl(null)).toBe(`https://github.com/${STOREFRONT_REPO}`);
    expect(deploySourceGitHubUrl(undefined)).toBe(`https://github.com/${STOREFRONT_REPO}`);
  });
});

describe('deployChannelLabel', () => {
  it('etiqueta pruebas con su fuente', () => {
    expect(deployChannelLabel(store({ deploySource: { kind: 'branch', ref: 'develop' } }))).toBe(
      'Rama develop',
    );
  });

  it('usa el targetChannel cuando no hay fuente de prueba', () => {
    expect(deployChannelLabel(store({ targetChannel: 'test' }))).toBe('Prueba');
    expect(deployChannelLabel(store({ targetChannel: 'stable' }))).toBe('Estable');
    expect(deployChannelLabel(store({}))).toBe('Estable');
  });

  it('tolera store nulo', () => {
    expect(deployChannelLabel(null)).toBe('Estable');
  });
});

describe('validateDeploySourceValue', () => {
  it('exige valor según el tipo', () => {
    expect(validateDeploySourceValue('release', '')).toBe('Elegí una versión de release.');
    expect(validateDeploySourceValue('branch', '  ')).toBe('Elegí o escribí una rama.');
    expect(validateDeploySourceValue('commit', '')).toBe('Ingresá un SHA de commit.');
  });

  it('valida releases semver', () => {
    expect(validateDeploySourceValue('release', '0.9.5')).toBeNull();
    expect(validateDeploySourceValue('release', 'v0.9.5')).toBeNull();
    expect(validateDeploySourceValue('release', 'latest')).toMatch(/Versión inválida/);
  });

  it('valida SHA', () => {
    expect(validateDeploySourceValue('commit', 'abc1234')).toBeNull();
    expect(validateDeploySourceValue('commit', 'zz')).toMatch(/SHA inválido/);
  });

  it('valida nombres de rama', () => {
    expect(validateDeploySourceValue('branch', 'develop')).toBeNull();
    expect(validateDeploySourceValue('branch', 'feat/mi-cambio')).toBeNull();
    expect(validateDeploySourceValue('branch', 'release/2026-01')).toBeNull();
    expect(validateDeploySourceValue('branch', 'feat/mi rama')).toMatch(/Nombre de rama inválido/);
    expect(validateDeploySourceValue('branch', '/feat')).toMatch(/no puede empezar/);
    expect(validateDeploySourceValue('branch', 'feat//x')).toMatch(/no puede empezar/);
    expect(validateDeploySourceValue('branch', 'HEAD')).toMatch(/no "HEAD"/);
  });
});
