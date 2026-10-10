import type { DeploySourceKind, Store, StoreDeploySource } from '@core/models/store';

/**
 * Presentación y validación de la fuente de despliegue (release vs prueba).
 *
 * Espeja las reglas de `deployment-source.ts` en las Cloud Functions: el backend es la
 * autoridad, esto sólo evita que el operador dispare algo que ya sabemos inválido y
 * garantiza que la UI nunca presente un build de prueba como una release.
 */

export const STOREFRONT_REPO = 'vertex-solutions-ar/ecommerce-vertex';

const BRANCH_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;

/** ¿Es una tienda del entorno development? Misma señal que usa el backend. */
export function isStoreDevEnvironment(store: Store | null | undefined): boolean {
  if (!store) {
    return false;
  }
  return (
    store.environment === 'development' ||
    String(store.firebaseProjectId || store.runtimeProjectId || '').includes('-dev')
  );
}

/** ¿Se puede desplegar ramas/commits en esta tienda? */
export function canDeployTestSources(store: Store | null | undefined): boolean {
  if (!store) {
    return false;
  }
  return isStoreDevEnvironment(store) || store.allowTestDeployments === true;
}

/** Un despliegue de prueba es cualquiera que no venga de un tag publicado. */
export function isTestDeploySource(source: StoreDeploySource | null | undefined): boolean {
  return source?.kind === 'branch' || source?.kind === 'commit';
}

/** Etiqueta corta de la fuente: `v0.9.5` | `feat/x` | `a1b2c3d`. */
export function deploySourceShortLabel(
  source: StoreDeploySource | null | undefined,
  fallbackVersion?: string,
): string {
  if (source?.ref) {
    return source.kind === 'release' && !source.ref.startsWith('v') ? `v${source.ref}` : source.ref;
  }
  if (fallbackVersion) {
    return fallbackVersion.startsWith('v') ? fallbackVersion : `v${fallbackVersion}`;
  }
  return '—';
}

/** Descripción legible de la fuente: `Release v0.9.5` | `Rama feat/x` | `Commit a1b2c3d`. */
export function deploySourceLabel(
  source: StoreDeploySource | null | undefined,
  fallbackVersion?: string,
): string {
  const ref = deploySourceShortLabel(source, fallbackVersion);
  if (ref === '—') {
    return ref;
  }
  switch (source?.kind) {
    case 'branch':
      return `Rama ${ref}`;
    case 'commit':
      return `Commit ${ref}`;
    default:
      return `Release ${ref}`;
  }
}

/** Sufijo ` @ abc1234` cuando hay commit conocido y la fuente no es un tag. */
export function deploySourceCommitSuffix(source: StoreDeploySource | null | undefined): string {
  const sha = source?.commitSha;
  if (!sha || source?.kind === 'release') {
    return '';
  }
  return ` @ ${sha.substring(0, 7)}`;
}

/** URL del commit/rama en GitHub, para verificar desde el panel qué se compiló. */
export function deploySourceGitHubUrl(source: StoreDeploySource | null | undefined): string {
  if (!source?.ref) {
    return `https://github.com/${STOREFRONT_REPO}`;
  }
  if (source.kind === 'release') {
    const tag = source.ref.startsWith('v') ? source.ref : `v${source.ref}`;
    return `https://github.com/${STOREFRONT_REPO}/releases/tag/${tag}`;
  }
  if (source.kind === 'commit') {
    return `https://github.com/${STOREFRONT_REPO}/commit/${source.ref}`;
  }
  return `https://github.com/${STOREFRONT_REPO}/tree/${source.ref}`;
}

/** Texto del resultado/canal para el badge de la tienda. */
export function deployChannelLabel(store: Store | null | undefined): string {
  const source = store?.deploySource;
  if (isTestDeploySource(source)) {
    return deploySourceLabel(source);
  }
  if (store?.targetChannel === 'test') {
    return 'Prueba';
  }
  return 'Estable';
}

/**
 * Valida el valor de una fuente antes de llamar al backend.
 * Devuelve el mensaje de error (español) o `null` si es aceptable.
 */
export function validateDeploySourceValue(kind: DeploySourceKind, rawValue: string): string | null {
  const value = (rawValue || '').trim();
  if (!value) {
    return kind === 'release'
      ? 'Elegí una versión de release.'
      : kind === 'branch'
        ? 'Elegí o escribí una rama.'
        : 'Ingresá un SHA de commit.';
  }

  if (kind === 'release') {
    const version = value.replace(/^v/, '');
    return /^\d+\.\d+\.\d+$/.test(version)
      ? null
      : 'Versión inválida. Se espera el formato X.Y.Z (ej. 0.9.5).';
  }

  if (kind === 'commit') {
    return COMMIT_SHA_PATTERN.test(value)
      ? null
      : 'SHA inválido. Se esperan de 7 a 40 caracteres hexadecimales.';
  }

  if (!BRANCH_REF_PATTERN.test(value)) {
    return 'Nombre de rama inválido. Sólo letras, números y . _ - /';
  }
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) {
    return 'Nombre de rama inválido: no puede empezar ni terminar con "/", ni contener "//".';
  }
  if (value === 'HEAD') {
    return 'Usá un nombre de rama explícito, no "HEAD".';
  }
  return null;
}
