import { Clinic, Hcp } from '../types/territory';

export interface LocalWorkPrefs {
  sameClinicGapMinutes: number;
  workdaysLeft: number;
  blankCellOverwritesVerified: boolean;
  shiftStartMinute: number; // default 13:00 (780)
  shiftEndMinute: number; // default 21:00 (1260)
}

export const DEFAULT_LOCAL_PREFS: LocalWorkPrefs = {
  sameClinicGapMinutes: 0,
  workdaysLeft: 42,
  blankCellOverwritesVerified: false,
  shiftStartMinute: 13 * 60,
  shiftEndMinute: 21 * 60,
};

export function loadLocalPrefs(uid: string): LocalWorkPrefs {
  try {
    const raw = localStorage.getItem(`trx_local_prefs_${uid}`);
    if (!raw) return DEFAULT_LOCAL_PREFS;
    return { ...DEFAULT_LOCAL_PREFS, ...(JSON.parse(raw) as Partial<LocalWorkPrefs>) };
  } catch {
    return DEFAULT_LOCAL_PREFS;
  }
}

export function saveLocalPrefs(uid: string, prefs: Partial<LocalWorkPrefs>): LocalWorkPrefs {
  const merged = { ...loadLocalPrefs(uid), ...prefs };
  try {
    localStorage.setItem(`trx_local_prefs_${uid}`, JSON.stringify(merged));
  } catch {
    // Ignore storage quota issues
  }
  return merged;
}

export interface ImportHistoryEntry {
  id: string;
  timestamp: number;
  fileName: string;
  mode: string;
  hcpsImported: number;
  clinicsImported: number;
  createdHcpIds: string[];
  createdClinicIds: string[];
  previousHcps: Hcp[];
  previousClinics: Clinic[];
  rolledBack?: boolean;
}

export function loadImportHistory(uid: string): ImportHistoryEntry[] {
  try {
    const raw = localStorage.getItem(`trx_import_history_${uid}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ImportHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveImportHistory(uid: string, entries: ImportHistoryEntry[]): void {
  try {
    localStorage.setItem(`trx_import_history_${uid}`, JSON.stringify(entries.slice(0, 12)));
  } catch {
    // Ignore storage quota errors
  }
}
