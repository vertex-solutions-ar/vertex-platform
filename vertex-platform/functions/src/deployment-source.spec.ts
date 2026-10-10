import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  assertDeploySourceAllowed,
  isStoreDev,
  normalizeReleaseVersion,
  parseDeploySourceRequest,
  resolveDefaultDeploySource,
  resolveDeploySource,
  resolveReactivationDeploySource,
  toGitRef,
  toPersistedDeploySource,
} from './deployment-source';

vi.mock('./helpers', () => ({
  getGitHubPat: vi.fn(async () => 'test-pat'),
}));

const DEV_STORE = { environment: 'development' as const, firebaseProjectId: 'ecommerce-dev-01' };
const PROD_STORE = { environment: 'production' as const, firebaseProjectId: 'ecommerce-vertex' };

describe('isStoreDev', () => {
  it('detecta entorno development explícito', () => {
    expect(isStoreDev({ environment: 'development' })).toBe(true);
  });

  it('detecta projectId con sufijo -dev', () => {
    expect(isStoreDev({ firebaseProjectId: 'vtx-mitienda-dev' })).toBe(true);
    expect(isStoreDev({ runtimeProjectId: 'vtx-otra-dev' })).toBe(true);
  });

  it('no marca como dev una tienda de producción', () => {
    expect(isStoreDev(PROD_STORE)).toBe(false);
    expect(isStoreDev({})).toBe(false);
  });
});

describe('parseDeploySourceRequest', () => {
  it('devuelve null cuando no se pidió fuente explícita', () => {
    expect(parseDeploySourceRequest(undefined, undefined)).toBeNull();
    expect(parseDeploySourceRequest(null, '')).toBeNull();
    expect(parseDeploySourceRequest({}, undefined)).toBeNull();
  });

  it('normaliza la forma nueva { kind, value }', () => {
    expect(parseDeploySourceRequest({ kind: 'branch', value: '  feat/x  ' }, undefined)).toEqual({
      kind: 'branch',
      value: 'feat/x',
    });
  });

  it('interpreta la forma legacy `ref` como rama', () => {
    expect(parseDeploySourceRequest(undefined, 'develop')).toEqual({
      kind: 'branch',
      value: 'develop',
    });
  });

  it('acepta `refs/heads/...` en la forma legacy', () => {
    expect(parseDeploySourceRequest(undefined, 'refs/heads/feat/x')).toEqual({
      kind: 'branch',
      value: 'feat/x',
    });
  });

  it('rechaza kinds desconocidos', () => {
    expect(() => parseDeploySourceRequest({ kind: 'mainframe', value: 'x' }, undefined)).toThrow(
      HttpsError,
    );
  });

  it('rechaza value vacío', () => {
    expect(() => parseDeploySourceRequest({ kind: 'branch', value: '   ' }, undefined)).toThrow(
      HttpsError,
    );
  });
});

describe('normalizeReleaseVersion / toGitRef', () => {
  it('quita el prefijo v', () => {
    expect(normalizeReleaseVersion('v0.9.5')).toBe('0.9.5');
    expect(normalizeReleaseVersion(' 0.9.5 ')).toBe('0.9.5');
  });

  it('arma refs de git canónicos', () => {
    expect(toGitRef('release', '0.9.5')).toBe('refs/tags/v0.9.5');
    expect(toGitRef('branch', 'feat/x')).toBe('feat/x');
    expect(toGitRef('commit', 'abc1234')).toBe('abc1234');
  });
});

describe('assertDeploySourceAllowed', () => {
  it('permite releases en cualquier tienda', () => {
    expect(() =>
      assertDeploySourceAllowed(PROD_STORE, { kind: 'release', value: '0.9.5' }),
    ).not.toThrow();
  });

  it('rechaza versiones de release con formato inválido', () => {
    expect(() =>
      assertDeploySourceAllowed(PROD_STORE, { kind: 'release', value: 'latest' }),
    ).toThrow(/Versión de release inválida/);
  });

  it('rechaza ramas en tiendas que no son dev', () => {
    expect(() =>
      assertDeploySourceAllowed(PROD_STORE, { kind: 'branch', value: 'develop' }),
    ).toThrow(/no es de entorno development/);
  });

  it('permite ramas en tiendas dev', () => {
    expect(() =>
      assertDeploySourceAllowed(DEV_STORE, { kind: 'branch', value: 'feat/x' }),
    ).not.toThrow();
  });

  it('permite ramas fuera de dev sólo con opt-in explícito', () => {
    expect(() =>
      assertDeploySourceAllowed(
        { ...PROD_STORE, allowTestDeployments: true },
        { kind: 'branch', value: 'develop' },
      ),
    ).not.toThrow();
    expect(() =>
      assertDeploySourceAllowed(
        { ...PROD_STORE, allowTestDeployments: false },
        { kind: 'branch', value: 'develop' },
      ),
    ).toThrow(HttpsError);
  });

  it('valida el formato de rama', () => {
    expect(() =>
      assertDeploySourceAllowed(DEV_STORE, { kind: 'branch', value: 'feat/mi rama' }),
    ).toThrow(/Nombre de rama inválido/);
    expect(() => assertDeploySourceAllowed(DEV_STORE, { kind: 'branch', value: '/feat' })).toThrow(
      /No puede empezar/,
    );
    expect(() =>
      assertDeploySourceAllowed(DEV_STORE, { kind: 'branch', value: 'feat//x' }),
    ).toThrow(/No puede empezar/);
    expect(() => assertDeploySourceAllowed(DEV_STORE, { kind: 'branch', value: 'HEAD' })).toThrow(
      /HEAD/,
    );
  });

  it('valida el formato de SHA', () => {
    expect(() => assertDeploySourceAllowed(DEV_STORE, { kind: 'commit', value: 'zzz' })).toThrow(
      /SHA inválido/,
    );
    expect(() =>
      assertDeploySourceAllowed(DEV_STORE, { kind: 'commit', value: 'a1b2c3d' }),
    ).not.toThrow();
  });
});

describe('resolveDefaultDeploySource', () => {
  it('usa develop para tiendas dev con autoUpdate en sandbox', () => {
    const source = resolveDefaultDeploySource({ ...DEV_STORE, autoUpdate: true }, 'development');
    expect(source).toMatchObject({ kind: 'branch', ref: 'develop', gitRef: 'develop' });
  });

  it('NUNCA compila develop en una tienda de producción dentro del sandbox', () => {
    const source = resolveDefaultDeploySource({ ...PROD_STORE, autoUpdate: true }, 'development');
    expect(source.ref).not.toBe('develop');
    expect(source.kind).toBe('branch');
    expect(source.ref).toBe('main');
  });

  it('en sandbox una tienda de producción con versión fijada usa su tag', () => {
    const source = resolveDefaultDeploySource(
      { ...PROD_STORE, autoUpdate: true, templateVersion: '0.9.5' },
      'development',
    );
    expect(source).toMatchObject({ kind: 'release', ref: 'v0.9.5', gitRef: 'refs/tags/v0.9.5' });
  });

  it('en producción con autoUpdate usa main', () => {
    const source = resolveDefaultDeploySource({ ...PROD_STORE, autoUpdate: true }, 'production');
    expect(source).toMatchObject({ kind: 'branch', ref: 'main' });
  });

  it('sin autoUpdate fija estrictamente su templateVersion', () => {
    const source = resolveDefaultDeploySource(
      { ...PROD_STORE, autoUpdate: false, templateVersion: 'v0.9.4' },
      'production',
    );
    expect(source).toMatchObject({ kind: 'release', ref: 'v0.9.4' });
  });

  it('sin autoUpdate ni templateVersion cae a la rama destino', () => {
    const source = resolveDefaultDeploySource({ ...PROD_STORE, autoUpdate: false }, 'production');
    expect(source).toMatchObject({ kind: 'branch', ref: 'main' });
  });
});

describe('resolveReactivationDeploySource', () => {
  it('reusa la fuente persistida cuando sigue permitida', () => {
    const source = resolveReactivationDeploySource(
      {
        ...DEV_STORE,
        deploySource: { kind: 'branch', ref: 'feat/x', commitSha: 'abc1234' },
      },
      'development',
    );
    expect(source).toMatchObject({ kind: 'branch', ref: 'feat/x', commitSha: 'abc1234' });
  });

  it('cae a la política estándar si la fuente persistida ya no está permitida', () => {
    const source = resolveReactivationDeploySource(
      {
        ...PROD_STORE,
        autoUpdate: false,
        templateVersion: '0.9.5',
        deploySource: { kind: 'branch', ref: 'develop' },
      },
      'production',
    );
    expect(source).toMatchObject({ kind: 'release', ref: 'v0.9.5' });
  });

  it('cae a la política estándar si no hay fuente persistida', () => {
    const source = resolveReactivationDeploySource(
      { ...DEV_STORE, autoUpdate: true },
      'development',
    );
    expect(source).toMatchObject({ kind: 'branch', ref: 'develop' });
  });
});

describe('toPersistedDeploySource', () => {
  it('marca la fuente como pending con su procedencia', () => {
    const persisted = toPersistedDeploySource(
      {
        kind: 'branch',
        ref: 'develop',
        gitRef: 'develop',
        commitSha: 'abc1234',
        commitMessage: 'feat: algo',
        commitDate: '2026-01-01T00:00:00Z',
      },
      'uid-1',
    );
    expect(persisted).toMatchObject({
      kind: 'branch',
      ref: 'develop',
      commitSha: 'abc1234',
      status: 'pending',
      error: null,
      requestedBy: 'uid-1',
    });
    expect(persisted.requestedAt).toBeInstanceOf(Date);
  });
});

describe('resolveDeploySource (validación contra GitHub)', () => {
  const okResponse = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => '',
    }) as unknown as Response;
  const notFound = () =>
    ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => 'Not Found',
    }) as unknown as Response;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resuelve una release a su tag y commit real', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({
        sha: 'f'.repeat(40),
        commit: {
          message: 'chore(release): 0.9.5\n\nnotas',
          committer: { date: '2026-01-02T00:00:00Z' },
        },
      }),
    );

    const source = await resolveDeploySource({ kind: 'release', value: 'v0.9.5' });
    expect(source).toMatchObject({
      kind: 'release',
      ref: 'v0.9.5',
      gitRef: 'refs/tags/v0.9.5',
      commitSha: 'f'.repeat(40),
      commitMessage: 'chore(release): 0.9.5',
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/commits/v0.9.5');
  });

  it('resuelve una rama con barra probando la variante encoded', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(notFound());
    fetchMock.mockResolvedValueOnce(
      okResponse({
        sha: 'a'.repeat(40),
        commit: { message: 'feat: prueba', committer: { date: '2026-01-03T00:00:00Z' } },
      }),
    );

    const source = await resolveDeploySource({ kind: 'branch', value: 'feat/mi-cambio' });
    expect(source).toMatchObject({
      kind: 'branch',
      ref: 'feat/mi-cambio',
      gitRef: 'feat/mi-cambio',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('feat%2Fmi-cambio');
  });

  it('falla con not-found claro si la rama no existe', async () => {
    vi.mocked(fetch).mockResolvedValue(notFound());
    await expect(resolveDeploySource({ kind: 'branch', value: 'no-existe' })).rejects.toThrow(
      /no existe en el repositorio/,
    );
  });

  it('falla con not-found claro si la release no existe', async () => {
    vi.mocked(fetch).mockResolvedValue(notFound());
    await expect(resolveDeploySource({ kind: 'release', value: '9.9.9' })).rejects.toThrow(
      /La release v9.9.9 no existe/,
    );
  });

  it('propaga como internal un error inesperado de la API', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    } as unknown as Response);
    await expect(resolveDeploySource({ kind: 'branch', value: 'develop' })).rejects.toThrow(
      /No se pudo consultar GitHub \(500\)/,
    );
  });

  it('resuelve un SHA explícito', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({
        sha: 'b'.repeat(40),
        commit: { message: 'fix: algo', author: { date: '2026-01-04T00:00:00Z' } },
      }),
    );
    const source = await resolveDeploySource({ kind: 'commit', value: 'b'.repeat(40) });
    expect(source).toMatchObject({
      kind: 'commit',
      ref: 'b'.repeat(40),
      commitSha: 'b'.repeat(40),
    });
  });
});
