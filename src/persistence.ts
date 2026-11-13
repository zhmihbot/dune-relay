export const BEST_SCORE_STORAGE_KEY = 'dune_relay_best_score';
export const MUTED_STORAGE_KEY = 'dune_relay_muted';

function resolveDefaultStorage(
  explicitStorage?: Storage | null
): Storage | null {
  if (explicitStorage !== undefined) {
    return explicitStorage;
  }
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return globalThis.localStorage ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

export function loadBestScore(storage?: Storage | null): number {
  const target = resolveDefaultStorage(storage);
  if (!target) {
    return 0;
  }

  try {
    const raw = target.getItem(BEST_SCORE_STORAGE_KEY);
    if (typeof raw !== 'string') {
      return 0;
    }
    const trimmed = raw.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      return 0;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return Math.floor(parsed);
  } catch {
    return 0;
  }
}

export function saveBestScore(
  score: number,
  storage?: Storage | null
): boolean {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) {
    return false;
  }

  const target = resolveDefaultStorage(storage);
  if (!target) {
    return false;
  }

  try {
    const sanitized = Math.floor(score);
    target.setItem(BEST_SCORE_STORAGE_KEY, String(sanitized));
    return true;
  } catch {
    return false;
  }
}

export function loadMutedPreference(storage?: Storage | null): boolean {
  const target = resolveDefaultStorage(storage);
  if (!target) {
    return false;
  }

  try {
    const raw = target.getItem(MUTED_STORAGE_KEY);
    if (typeof raw !== 'string') {
      return false;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function saveMutedPreference(
  muted: boolean,
  storage?: Storage | null
): boolean {
  if (typeof muted !== 'boolean') {
    return false;
  }

  const target = resolveDefaultStorage(storage);
  if (!target) {
    return false;
  }

  try {
    target.setItem(MUTED_STORAGE_KEY, muted ? 'true' : 'false');
    return true;
  } catch {
    return false;
  }
}
