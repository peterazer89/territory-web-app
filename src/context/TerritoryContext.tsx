import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import {
  Clinic,
  DailyPlan,
  Hcp,
  SyncState,
  ThemeMode,
  Visit,
  WeeklyLock,
  WorkSettings,
} from '../types/territory';
import { auth, googleProvider } from '../lib/firebase';
import {
  createDefaultWorkSettings,
  forceCloudSync,
  saveWorkSettings,
  subscribeUserCollection,
  subscribeWorkSettings,
  type SnapshotMetaReport,
} from '../lib/firestoreService';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

interface TerritoryContextValue {
  user: User | null;
  authReady: boolean;
  authError: string | null;
  signingIn: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;

  hcps: Hcp[];
  clinics: Clinic[];
  visits: Visit[];
  weeklyLocks: WeeklyLock[];
  plans: DailyPlan[];
  settings: WorkSettings;
  dataLoaded: boolean;

  syncState: SyncState;
  isOnline: boolean;
  isIOSSafari: boolean;
  triggerManualSync: () => Promise<void>;
  updateSettings: (next: Partial<WorkSettings>) => Promise<void>;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
}

const TerritoryContext = createContext<TerritoryContextValue | null>(null);

function applyThemeToDocument(mode: ThemeMode) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const shouldDark = mode === 'DARK' || (mode === 'SYSTEM' && prefersDark);
  root.classList.toggle('dark', shouldDark);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', shouldDark ? '#0F172A' : '#0B2559');
  }
}

export const TerritoryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [hcps, setHcps] = useState<Hcp[]>([]);
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [weeklyLocks, setWeeklyLocks] = useState<WeeklyLock[]>([]);
  const [plans, setPlans] = useState<DailyPlan[]>([]);
  const [settings, setSettings] = useState<WorkSettings>(() => createDefaultWorkSettings(''));
  const [dataLoaded, setDataLoaded] = useState(false);

  const { isOnline, isIOSSafari } = useOnlineStatus();
  const [syncState, setSyncState] = useState<SyncState>({
    status: 'SYNCING',
    hasPendingWrites: false,
    fromCache: false,
    lastSyncedAt: null,
    errorMessage: null,
  });

  const metaBySourceRef = useRef<Record<string, SnapshotMetaReport>>({});
  const bootstrappedSettingsRef = useRef(false);

  // Persist local theme preference so even the Auth screen honors chosen theme
  useEffect(() => {
    const saved = (localStorage.getItem('territory_rx_theme') as ThemeMode | null) || 'SYSTEM';
    applyThemeToDocument(saved);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const current = (localStorage.getItem('territory_rx_theme') as ThemeMode | null) || 'SYSTEM';
      if (current === 'SYSTEM') applyThemeToDocument('SYSTEM');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (settings.themeMode) {
      localStorage.setItem('territory_rx_theme', settings.themeMode);
      applyThemeToDocument(settings.themeMode);
    }
  }, [settings.themeMode]);

  const recomputeSyncState = useCallback(
    (sourceKey: string, meta: SnapshotMetaReport) => {
      metaBySourceRef.current[sourceKey] = meta;
      const all = Object.values(metaBySourceRef.current);
      const hasPending = all.some((m) => m.hasPendingWrites);
      const allFromCache = all.length > 0 && all.every((m) => m.fromCache);

      setSyncState((prev) => {
        if (!navigator.onLine) {
          return {
            ...prev,
            status: hasPending ? 'PENDING_OFFLINE' : 'OFFLINE',
            hasPendingWrites: hasPending,
            fromCache: allFromCache,
          };
        }
        return {
          status: hasPending ? 'SYNCING' : 'SYNCED',
          hasPendingWrites: hasPending,
          fromCache: allFromCache,
          lastSyncedAt: !hasPending && !allFromCache ? new Date() : prev.lastSyncedAt,
          errorMessage: null,
        };
      });
    },
    []
  );

  // Sync status reflects online/offline transitions immediately
  useEffect(() => {
    setSyncState((prev) => {
      if (!isOnline) {
        return {
          ...prev,
          status: prev.hasPendingWrites ? 'PENDING_OFFLINE' : 'OFFLINE',
        };
      }
      if (prev.status === 'OFFLINE' || prev.status === 'PENDING_OFFLINE') {
        return {
          ...prev,
          status: prev.hasPendingWrites ? 'SYNCING' : 'SYNCED',
        };
      }
      return prev;
    });
  }, [isOnline]);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setAuthReady(true);
      if (!firebaseUser) {
        setHcps([]);
        setClinics([]);
        setVisits([]);
        setWeeklyLocks([]);
        setPlans([]);
        setDataLoaded(false);
        metaBySourceRef.current = {};
        bootstrappedSettingsRef.current = false;
      }
    });
    return () => unsub();
  }, []);

  // Attach real-time Firestore listeners once authenticated
  useEffect(() => {
    if (!authReady || !user) return;

    const uid = user.uid;
    let loadedFlags = {
      hcps: false,
      clinics: false,
      visits: false,
      weeklyLocks: false,
      plans: false,
      settings: false,
    };

    const checkAllLoaded = () => {
      if (Object.values(loadedFlags).every(Boolean)) {
        setDataLoaded(true);
      }
    };

    const onErr = (err: Error) => {
      setSyncState((prev) => ({
        ...prev,
        status: 'ERROR',
        errorMessage: err.message,
      }));
    };

    const u1 = subscribeUserCollection<Hcp>(
      uid,
      'hcps',
      (items, meta) => {
        setHcps(items);
        loadedFlags.hcps = true;
        recomputeSyncState('hcps', meta);
        checkAllLoaded();
      },
      onErr
    );

    const u2 = subscribeUserCollection<Clinic>(
      uid,
      'clinics',
      (items, meta) => {
        setClinics(items);
        loadedFlags.clinics = true;
        recomputeSyncState('clinics', meta);
        checkAllLoaded();
      },
      onErr
    );

    const u3 = subscribeUserCollection<Visit>(
      uid,
      'visits',
      (items, meta) => {
        setVisits(items);
        loadedFlags.visits = true;
        recomputeSyncState('visits', meta);
        checkAllLoaded();
      },
      onErr
    );

    const u4 = subscribeUserCollection<WeeklyLock>(
      uid,
      'weeklyLocks',
      (items, meta) => {
        setWeeklyLocks(items);
        loadedFlags.weeklyLocks = true;
        recomputeSyncState('weeklyLocks', meta);
        checkAllLoaded();
      },
      onErr
    );

    const u5 = subscribeUserCollection<DailyPlan>(
      uid,
      'plans',
      (items, meta) => {
        setPlans(items);
        loadedFlags.plans = true;
        recomputeSyncState('plans', meta);
        checkAllLoaded();
      },
      onErr
    );

    const u6 = subscribeWorkSettings(
      uid,
      (workSettings, existsInCloud, meta) => {
        setSettings(workSettings);
        loadedFlags.settings = true;
        recomputeSyncState('settings', meta);
        checkAllLoaded();
        if (!existsInCloud && !bootstrappedSettingsRef.current && navigator.onLine) {
          bootstrappedSettingsRef.current = true;
          void saveWorkSettings(uid, workSettings).catch(() => {});
        }
      },
      onErr
    );

    return () => {
      u1();
      u2();
      u3();
      u4();
      u5();
      u6();
    };
  }, [authReady, user, recomputeSyncState]);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    setSigningIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google Sign-In failed.';
      setAuthError(msg);
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
  }, []);

  const triggerManualSync = useCallback(async () => {
    if (!user) return;
    if (!navigator.onLine) {
      setSyncState((prev) => ({
        ...prev,
        status: prev.hasPendingWrites ? 'PENDING_OFFLINE' : 'OFFLINE',
        errorMessage: 'Device is currently offline. Cached IndexedDB data remains available.',
      }));
      return;
    }

    setSyncState((prev) => ({ ...prev, status: 'SYNCING', errorMessage: null }));
    try {
      const res = await forceCloudSync(user.uid);
      setSyncState({
        status: 'SYNCED',
        hasPendingWrites: false,
        fromCache: false,
        lastSyncedAt: res.syncedAt,
        errorMessage: null,
      });
    } catch (err) {
      setSyncState((prev) => ({
        ...prev,
        status: 'ERROR',
        errorMessage: err instanceof Error ? err.message : 'Cloud sync failed.',
      }));
    }
  }, [user]);

  // Foreground resume refresh (helpful especially on iOS Safari PWA)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && user && navigator.onLine) {
        void triggerManualSync();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [user, triggerManualSync]);

  const updateSettings = useCallback(
    async (next: Partial<WorkSettings>) => {
      if (!user) return;
      const merged: WorkSettings = {
        ...settings,
        ...next,
        userId: user.uid,
      };
      setSettings(merged);
      await saveWorkSettings(user.uid, merged);
    },
    [user, settings]
  );

  const setThemeMode = useCallback(
    async (mode: ThemeMode) => {
      localStorage.setItem('territory_rx_theme', mode);
      applyThemeToDocument(mode);
      if (user) {
        await updateSettings({ themeMode: mode });
      }
    },
    [user, updateSettings]
  );

  const value = useMemo<TerritoryContextValue>(
    () => ({
      user,
      authReady,
      authError,
      signingIn,
      signInWithGoogle,
      signOut,
      hcps,
      clinics,
      visits,
      weeklyLocks,
      plans,
      settings,
      dataLoaded,
      syncState,
      isOnline,
      isIOSSafari,
      triggerManualSync,
      updateSettings,
      setThemeMode,
    }),
    [
      user,
      authReady,
      authError,
      signingIn,
      signInWithGoogle,
      signOut,
      hcps,
      clinics,
      visits,
      weeklyLocks,
      plans,
      settings,
      dataLoaded,
      syncState,
      isOnline,
      isIOSSafari,
      triggerManualSync,
      updateSettings,
      setThemeMode,
    ]
  );

  return <TerritoryContext.Provider value={value}>{children}</TerritoryContext.Provider>;
};

export function useTerritory(): TerritoryContextValue {
  const ctx = useContext(TerritoryContext);
  if (!ctx) throw new Error('useTerritory must be used inside TerritoryProvider');
  return ctx;
}
