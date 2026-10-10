import { HttpsError } from 'firebase-functions/v2/https';
import { getGitHubPat } from './helpers';

/**
 * Fuente de despliegue de una tienda: de qué ref de git se compiló el storefront.
 *
 * Reemplaza el `ref` opcional y sin validar que aceptaba `redeployStore`, que permitía
 * despachar cualquier string a GitHub Actions evadiendo toda la política de actualización
 * y dejaba a la UI y al historial mintiendo sobre lo desplegado.
 *
 * Reglas:
 *  - `release`: tag publicado `vX.Y.Z`. Es el único modo permitido en tiendas de producción.
 *  - `branch` / `commit`: modo de prueba (sin tag). Sólo para tiendas de entorno
 *    development, salvo opt-in explícito (`allowTestDeployments`).
 *  - Todo ref explícito se valida contra la API de GitHub antes de despachar: si no existe,
 *    se falla con un mensaje claro en vez de dejar la tienda en `deploying`.
 */

export const STOREFRONT_REPO = 'vertex-solutions-ar/ecommerce-vertex';

export type DeploySourceKind = 'release' | 'branch' | 'commit';

export interface DeploySourceRequest {
  kind: DeploySourceKind;
  /** Valor tal como lo ingresó el operador: `0.9.5`, `develop`, `feat/x`, `a1b2c3d`. */
  value: string;
}

/** Fuente ya resuelta y validada contra GitHub. */
export interface ResolvedDeploySource {
  kind: DeploySourceKind;
  /** Valor canónico para mostrar: `v0.9.5` | `develop` | `feat/x` | `a1b2c3d`. */
  ref: string;
  /** Ref git que viaja en `client_payload.ref` hacia GitHub Actions. */
  gitRef: string;
  commitSha: string;
  commitMessage: string;
  commitDate: string;
}

/** Campos de `stores/{storeId}` que participan de las reglas de seguridad. */
export interface DeploySourceStore {
  environment?: 'development' | 'production';
  firebaseProjectId?: string;
  runtimeProjectId?: string;
  templateVersion?: string;
  autoUpdate?: boolean;
  /** Opt-in explícito para habilitar despliegues de prueba fuera de development. */
  allowTestDeployments?: boolean;
}

const BRANCH_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const KINDS: readonly DeploySourceKind[] = ['release', 'branch', 'commit'];

/**
 * ¿La tienda es de entorno development? Es la misma señal que usa la política de
 * actualización: `environment === 'development'` o un projectId `*-dev`.
 */
export function isStoreDev(store: DeploySourceStore): boolean {
  return (
    store.environment === 'development' ||
    String(store.firebaseProjectId || store.runtimeProjectId || '').includes('-dev')
  );
}

/**
 * Normaliza el payload recibido en una intención tipada.
 *
 * Acepta la forma nueva `{ kind, value }` y la forma legacy `ref: string`
 * (que se interpreta como `{ kind: 'branch' }` por retrocompatibilidad).
 * Devuelve `null` cuando no se pidió una fuente explícita — ahí manda la política
 * estándar de la tienda.
 */
export function parseDeploySourceRequest(
  source: { kind?: unknown; value?: unknown } | undefined | null,
  legacyRef?: unknown,
): DeploySourceRequest | null {
  if (source && typeof source === 'object') {
    const kind = typeof source.kind === 'string' ? (source.kind as DeploySourceKind) : null;
    const value = typeof source.value === 'string' ? source.value.trim() : '';
    // Objeto vacío = sin fuente explícita (el caller no pidió nada en particular).
    if (!kind && !value) return null;
    if (!kind || !KINDS.includes(kind)) {
      throw new HttpsError(
        'invalid-argument',
        `Tipo de fuente inválido. Valores admitidos: ${KINDS.join(', ')}.`,
      );
    }
    if (!value) {
      throw new HttpsError('invalid-argument', 'La fuente de despliegue está vacía.');
    }
    return { kind, value };
  }

  if (typeof legacyRef === 'string' && legacyRef.trim()) {
    // Forma legacy `ref`: se interpreta como rama, aceptando tanto `develop` como
    // `refs/heads/develop`.
    return { kind: 'branch', value: legacyRef.trim().replace(/^refs\/heads\//, '') };
  }

  return null;
}

/**
 * Valida el formato y las reglas de seguridad de la fuente pedida.
 * Lanza `HttpsError` con mensaje accionable cuando no puede aplicarse.
 */
export function assertDeploySourceAllowed(
  store: DeploySourceStore,
  request: DeploySourceRequest,
): void {
  if (request.kind === 'release') {
    const normalized = normalizeReleaseVersion(request.value);
    if (!RELEASE_VERSION_PATTERN.test(normalized)) {
      throw new HttpsError(
        'invalid-argument',
        `Versión de release inválida: "${request.value}". Se espera el formato X.Y.Z (ej. 0.9.5).`,
      );
    }
    return;
  }

  if (request.kind === 'commit') {
    if (!COMMIT_SHA_PATTERN.test(request.value)) {
      throw new HttpsError(
        'invalid-argument',
        `SHA inválido: "${request.value}". Se espera un hash de 7 a 40 caracteres hexadecimales.`,
      );
    }
  } else {
    if (!BRANCH_REF_PATTERN.test(request.value)) {
      throw new HttpsError(
        'invalid-argument',
        `Nombre de rama inválido: "${request.value}". Sólo se admiten letras, números y . _ - /`,
      );
    }
    if (
      request.value.startsWith('/') ||
      request.value.endsWith('/') ||
      request.value.includes('//')
    ) {
      throw new HttpsError(
        'invalid-argument',
        `Nombre de rama inválido: "${request.value}". No puede empezar/terminar con "/" ni contener "//".`,
      );
    }
    if (request.value === 'HEAD') {
      throw new HttpsError('invalid-argument', 'Usá un nombre de rama explícito, no "HEAD".');
    }
  }

  if (isStoreDev(store) || store.allowTestDeployments === true) {
    return;
  }

  throw new HttpsError(
    'failed-precondition',
    `La tienda no es de entorno development: sólo admite releases etiquetadas. ` +
      `Habilitá "Permitir despliegues de prueba" para desplegar ${request.kind === 'commit' ? 'un commit' : 'una rama'} explícito.`,
  );
}

/** `v0.9.5` / `0.9.5` → `0.9.5`. */
export function normalizeReleaseVersion(value: string): string {
  return value.trim().replace(/^v/, '');
}

/** Construye el `gitRef` que viaja a GitHub Actions a partir de una fuente resuelta. */
export function toGitRef(kind: DeploySourceKind, ref: string): string {
  if (kind === 'release') return `refs/tags/v${normalizeReleaseVersion(ref)}`;
  return ref;
}

interface GitHubCommitResponse {
  sha?: string;
  commit?: {
    message?: string;
    author?: { date?: string; name?: string };
    committer?: { date?: string };
  };
}

/**
 * Resuelve un ref (rama, tag `vX.Y.Z` o SHA) contra la API de GitHub.
 * Devuelve `null` si el ref no existe.
 */
async function fetchCommitForRef(
  pat: string,
  ref: string,
): Promise<{ sha: string; message: string; date: string } | null> {
  // Rutas con `/` (ej. `feat/mi-cambio`) pueden requerir encoding según el proxy/CDN,
  // por eso se prueban ambas formas antes de declarar el ref inexistente.
  const candidates = [ref, encodeURIComponent(ref)].filter((v, i, a) => a.indexOf(v) === i);

  for (const candidate of candidates) {
    const res = await fetch(
      `https://api.github.com/repos/${STOREFRONT_REPO}/commits/${candidate}`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15000),
      },
    );

    if (res.ok) {
      const data = (await res.json()) as GitHubCommitResponse;
      if (!data.sha) return null;
      return {
        sha: data.sha,
        message: (data.commit?.message || '').split('\n')[0].slice(0, 140),
        date: data.commit?.committer?.date || data.commit?.author?.date || '',
      };
    }

    if (res.status !== 404) {
      const body = await res.text();
      throw new HttpsError(
        'internal',
        `No se pudo consultar GitHub (${res.status}): ${body.slice(0, 180)}`,
      );
    }
  }

  return null;
}

/**
 * Valida la fuente pedida contra GitHub y la resuelve a un ref concreto + commit real.
 * Si el ref no existe, lanza antes de despachar (no se deja la tienda en `deploying`).
 */
export async function resolveDeploySource(
  request: DeploySourceRequest,
): Promise<ResolvedDeploySource> {
  const pat = await getGitHubPat();

  if (request.kind === 'release') {
    const version = normalizeReleaseVersion(request.value);
    const tagRef = `v${version}`;
    const commit = await fetchCommitForRef(pat, tagRef);
    if (!commit) {
      throw new HttpsError(
        'not-found',
        `La release v${version} no existe en el repositorio. Publicá el tag antes de desplegarla.`,
      );
    }
    return {
      kind: 'release',
      ref: tagRef,
      gitRef: `refs/tags/${tagRef}`,
      commitSha: commit.sha,
      commitMessage: commit.message,
      commitDate: commit.date,
    };
  }

  const commit = await fetchCommitForRef(pat, request.value);
  if (!commit) {
    throw new HttpsError(
      'not-found',
      request.kind === 'commit'
        ? `El commit ${request.value} no existe en el repositorio.`
        : `La rama "${request.value}" no existe en el repositorio. Revisá el nombre en GitHub.`,
    );
  }

  return {
    kind: request.kind,
    ref: request.value,
    gitRef: toGitRef(request.kind, request.value),
    commitSha: commit.sha,
    commitMessage: commit.message,
    commitDate: commit.date,
  };
}

/**
 * Política estándar de la tienda cuando no se pidió una fuente explícita.
 *
 * - En develop (sandbox): sólo si `autoUpdate=true` Y la tienda es de desarrollo califica
 *   a `develop`. Si es de producción, NUNCA compila develop.
 * - En main (producción): si `autoUpdate=true` compila `main`. Si `autoUpdate=false`
 *   compila estrictamente su `templateVersion` fijada.
 *
 * No consulta GitHub: es el camino caliente de `activateStore` y no debe agregar
 * una llamada externa ni un modo de fallo nuevo.
 */
export function resolveDefaultDeploySource(
  store: DeploySourceStore,
  platformEnv: string,
): ResolvedDeploySource {
  const targetRef =
    platformEnv === 'production' ? 'main' : platformEnv === 'local' ? 'local' : 'develop';

  const pinnedTag = store.templateVersion
    ? `v${normalizeReleaseVersion(store.templateVersion)}`
    : null;

  if (store.autoUpdate === true && platformEnv === 'development' && !isStoreDev(store)) {
    // Tienda de producción dentro del sandbox: jamás compila develop.
    return pinnedTag ? releaseSource(pinnedTag) : branchSource('main');
  }

  if (store.autoUpdate === true) {
    return branchSource(targetRef);
  }

  return pinnedTag ? releaseSource(pinnedTag) : branchSource(targetRef);
}

function branchSource(ref: string): ResolvedDeploySource {
  return {
    kind: 'branch',
    ref,
    gitRef: toGitRef('branch', ref),
    commitSha: '',
    commitMessage: '',
    commitDate: '',
  };
}

function releaseSource(tag: string): ResolvedDeploySource {
  return {
    kind: 'release',
    ref: tag,
    gitRef: toGitRef('release', tag),
    commitSha: '',
    commitMessage: '',
    commitDate: '',
  };
}

/**
 * Fuente de la que se compiló la tienda, ya persistida en `stores/{storeId}`.
 * Se usa para reactivar una tienda suspendida sobre la misma fuente que tenía
 * (incluida una rama de prueba), en vez de resetearla silenciosamente a stable.
 */
export interface StoredDeploySource {
  kind?: DeploySourceKind;
  ref?: string;
  gitRef?: string;
  commitSha?: string;
  commitMessage?: string;
  commitDate?: string;
}

/**
 * Resuelve qué fuente usar al reactivar una tienda:
 *  - Si tenía una fuente persistida y sigue permitida por las reglas de seguridad, se reusa.
 *  - Si no (p. ej. una rama de prueba sobre una tienda que dejó de ser dev), cae a la
 *    política estándar en vez de fallar.
 */
export function resolveReactivationDeploySource(
  store: DeploySourceStore & { deploySource?: StoredDeploySource | null },
  platformEnv: string,
): ResolvedDeploySource {
  const stored = store.deploySource;
  if (stored?.kind && stored.ref && KINDS.includes(stored.kind)) {
    try {
      assertDeploySourceAllowed(store, { kind: stored.kind, value: stored.ref });
      const kind = stored.kind;
      return {
        kind,
        ref: stored.ref,
        gitRef: stored.gitRef || toGitRef(kind, stored.ref),
        commitSha: stored.commitSha || '',
        commitMessage: stored.commitMessage || '',
        commitDate: stored.commitDate || '',
      };
    } catch {
      // Fuente persistida ya no permitida: se ignora y manda la política estándar.
    }
  }
  return resolveDefaultDeploySource(store, platformEnv);
}

/**
 * Objeto `deploySource` que se persiste en `stores/{storeId}` para saber qué está
 * desplegado (o en camino a estarlo) sin depender del estado del panel.
 */
export interface PersistedDeploySource {
  kind: DeploySourceKind;
  ref: string;
  gitRef: string;
  commitSha: string;
  commitMessage: string;
  commitDate: string;
  status: 'pending' | 'ok' | 'failed';
  error?: string | null;
  requestedAt: Date;
  requestedBy: string;
}

export function toPersistedDeploySource(
  source: ResolvedDeploySource,
  requestedBy: string,
): PersistedDeploySource {
  return {
    kind: source.kind,
    ref: source.ref,
    gitRef: source.gitRef,
    commitSha: source.commitSha,
    commitMessage: source.commitMessage,
    commitDate: source.commitDate,
    status: 'pending',
    error: null,
    requestedAt: new Date(),
    requestedBy: requestedBy || '',
  };
}
