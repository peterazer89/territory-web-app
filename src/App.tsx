/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppTab } from './types/territory';
import { TerritoryProvider, useTerritory } from './context/TerritoryContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OpeningPosterScreen } from './components/OpeningPosterScreen';
import { AuthScreen } from './components/AuthScreen';
import { AppShell, ToastMessage } from './components/AppShell';
import { TerritoryRxPinLogo } from './components/BrandMark';
import { PlannerTab } from './components/PlannerTab';
import { HcpsTab } from './components/HcpsTab';
import { ImportTab } from './components/ImportTab';
import { SettingsTab } from './components/SettingsTab';

const TerritoryAppContent: React.FC = () => {
  const { user, authReady } = useTerritory();
  const [showPoster, setShowPoster] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<AppTab>('planner');
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((text: string, type: 'success' | 'error' = 'success') => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ id: Date.now(), type, text });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  if (showPoster) {
    return <OpeningPosterScreen onStart={() => setShowPoster(false)} />;
  }

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#071633] flex flex-col items-center justify-center gap-4 text-white p-6">
        <TerritoryRxPinLogo className="w-16 h-[68px]" />
        <div className="text-center">
          <p className="text-lg font-extrabold tracking-tight">
            Territory <span className="text-[#0A6BFF]">Rx</span>
          </p>
          <p className="mt-1 text-xs text-slate-300">Connecting to your shared territory...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <AppShell
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      onOpenPoster={() => setShowPoster(true)}
      isBusy={isBusy}
      toast={toast}
      onDismissToast={() => setToast(null)}
    >
      {activeTab === 'planner' && (
        <PlannerTab onToast={showToast} onBusyChange={setIsBusy} />
      )}
      {activeTab === 'hcps' && (
        <HcpsTab onToast={showToast} onBusyChange={setIsBusy} />
      )}
      {activeTab === 'import' && (
        <ImportTab onToast={showToast} onBusyChange={setIsBusy} />
      )}
      {activeTab === 'settings' && (
        <SettingsTab
          onToast={showToast}
          onOpenPoster={() => setShowPoster(true)}
        />
      )}
    </AppShell>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <TerritoryProvider>
        <TerritoryAppContent />
      </TerritoryProvider>
    </ErrorBoundary>
  );
}
