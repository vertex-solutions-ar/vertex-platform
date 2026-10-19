/**
 * Utilidades para normalización y manejo de versiones y tags de release en la plataforma.
 */

/**
 * Normaliza un tag de versión asegurando exactamente un prefijo 'v'.
 * Si el valor está vacío o no es válido, retorna 'v0.0.0'.
 */
export function normalizeVersionTag(raw?: string | null): string {
  if (!raw || !raw.trim()) {
    return 'v0.0.0';
  }
  return `v${raw.trim().replace(/^v+/i, '')}`;
}

/**
 * Normaliza un tag de versión o retorna un valor fallback si está vacío.
 */
export function normalizeVersionTagOr(raw: string | null | undefined, fallback: string): string {
  if (!raw || !raw.trim()) {
    return fallback;
  }
  return `v${raw.trim().replace(/^v+/i, '')}`;
}

/**
 * Limpia cualquier prefijo 'v' para obtener el número de versión puro (ej: '0.9.8').
 */
export function cleanVersionNumber(raw?: string | null): string {
  if (!raw || !raw.trim()) {
    return '0.0.0';
  }
  return raw.trim().replace(/^v+/i, '');
}
