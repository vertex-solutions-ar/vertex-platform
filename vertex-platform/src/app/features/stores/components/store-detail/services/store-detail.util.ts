import type { ProvisioningStep } from '@core/models/store';

export const STEP_ORDER = [
  'createProject',
  'linkBilling',
  'addFirebase',
  'enableApis',
  'createWebApp',
  'initFirestore',
  'configureEmail',
  'initAdmin',
  'grantAccess',
  'triggerDeploy',
];

export interface ActionProgressState {
  status: 'idle' | 'running' | 'success' | 'error';
  progress: number;
  message: string;
}

export const IDLE_STATE: ActionProgressState = { status: 'idle', progress: 0, message: '' };

export interface DeploymentHistoryItem {
  id?: string;
  timestamp?: { toDate?: () => Date };
  success?: boolean;
  version?: string;
  ref?: string;
  commitSha?: string;
  commitMessage?: string;
  /** `release` | `branch` | `commit` — procedencia real del build. */
  sourceKind?: string;
}

export function parseDateToMillis(dateVal: unknown): number {
  if (!dateVal) {
    return 0;
  }
  if (typeof dateVal === 'number') {
    return isNaN(dateVal) ? 0 : dateVal;
  }
  if (dateVal instanceof Date) {
    return isNaN(dateVal.getTime()) ? 0 : dateVal.getTime();
  }
  if (typeof dateVal === 'string') {
    const matchTs = dateVal.match(/Timestamp\(seconds=(\d+),\s*nanoseconds=(\d+)\)/);
    if (matchTs) {
      return parseInt(matchTs[1], 10) * 1000;
    }
    const matchDmy = dateVal.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/,
    );
    if (matchDmy) {
      const day = parseInt(matchDmy[1], 10);
      const month = parseInt(matchDmy[2], 10) - 1;
      const year = parseInt(matchDmy[3], 10);
      const hour = matchDmy[4] ? parseInt(matchDmy[4], 10) : 0;
      const min = matchDmy[5] ? parseInt(matchDmy[5], 10) : 0;
      const sec = matchDmy[6] ? parseInt(matchDmy[6], 10) : 0;
      const d = new Date(year, month, day, hour, min, sec);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    }
    const d = new Date(dateVal);
    if (!isNaN(d.getTime())) {
      return d.getTime();
    }
  }
  if (typeof dateVal === 'object' && dateVal !== null) {
    const val = dateVal as Record<string, unknown>;
    if (typeof val['toDate'] === 'function') {
      try {
        const d = (val['toDate'] as () => Date)();
        if (d instanceof Date && !isNaN(d.getTime())) {
          return d.getTime();
        }
      } catch {
        // Fallback to seconds property
      }
    }
    if (typeof val['seconds'] === 'number') {
      return (val['seconds'] as number) * 1000;
    }
    if (typeof val['_seconds'] === 'number') {
      return (val['_seconds'] as number) * 1000;
    }
  }
  return 0;
}

export function formatDateUtil(dateVal: unknown): Date | string | null {
  if (!dateVal) {
    return null;
  }
  const millis = parseDateToMillis(dateVal);
  return millis > 0 ? new Date(millis) : (dateVal as Date | string | null);
}

export function statusLabelUtil(status: string): string {
  const labels: Record<string, string> = {
    provisioning: 'Aprovisionando',
    active: 'Activa',
    suspended: 'Suspendida',
    error: 'Error',
  };
  return labels[status] ?? status;
}

export function stepIconUtil(status: ProvisioningStep['status']): string {
  return { pending: '○', running: '…', done: '✓', error: '✗' }[status] ?? '○';
}

export function formatDeployHistoryUtil(
  history: DeploymentHistoryItem[],
  storeVer?: string,
): DeploymentHistoryItem[] {
  return history.map((item) => {
    const ver = String(item.version || '');
    if ((!ver || ver === '0.1.0') && storeVer) {
      return { ...item, version: storeVer.replace(/^v/, '') };
    }
    return item;
  });
}

/**
 * Procedencia del build en el historial de despliegues.
 * Los registros previos a la fuente de despliegue no tienen `sourceKind`: se asumen release.
 */
export function deployHistorySourceKind(item: DeploymentHistoryItem): string {
  return item.sourceKind || 'release';
}

/** Etiqueta legible de la procedencia del build en el historial. */
export function deployHistorySourceLabel(item: DeploymentHistoryItem): string {
  const labels: Record<string, string> = { release: 'Release', branch: 'Rama', commit: 'Commit' };
  return labels[deployHistorySourceKind(item)] ?? 'Release';
}

export function isVersionOutdated(currentVer?: string, latestVer?: string): boolean {
  if (!currentVer || !latestVer) {
    return false;
  }
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const cur = parse(currentVer);
  const lat = parse(latestVer);
  for (let i = 0; i < Math.max(cur.length, lat.length); i++) {
    const c = cur[i] ?? 0;
    const l = lat[i] ?? 0;
    if (c < l) {
      return true;
    }
    if (c > l) {
      return false;
    }
  }
  return false;
}
