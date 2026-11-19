import React from 'react';
import {
  BriefcaseMedical,
  CheckCircle2,
  Loader2,
  Moon,
  Route,
  Settings,
  Sun,
  Table2,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { AppTab } from '../types/territory';
import { useTerritory } from '../context/TerritoryContext';
import { PharmacyBadgeIcon } from './BrandMark';

export interface ToastMessage {
  id: number;
  type: 'success' | 'error';
  text: string;
}

interface AppShellProps {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onOpenPoster: () => void;
  isBusy: boolean;
  toast: ToastMessage | null;
  onDismissToast: () => void;
  children: React.ReactNode;
}

const TOP_TITLES: Record<AppTab, string> = {
  planner: 'Route Planner',
  hcps: 'HCP Directory',
  import: 'Excel & CSV Import',
  settings: 'Settings & Cloud',
};

export const AppShell: React.FC<AppShellProps> = ({
  activeTab,
  onSelectTab,
  onOpenPoster,
  isBusy,
  toast,
  onDismissToast,
  children,
}) => {
  const { hcps, settings, syncState, isOnline, setThemeMode } = useTerritory();

  const activeHcpsCount = React.useMemo(
    () => hcps.filter((h) => h.isActive && !h.isDeleted).length,
    [hcps]
  );

  const isDarkActive =
    settings.themeMode === 'DARK' ||
    (settings.themeMode === 'SYSTEM' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  const handleToggleTheme = () => {
    void setThemeMode(isDarkActive ? 'LIGHT' : 'DARK');
  };

  const showWorkingPill = isBusy || syncState.status === 'SYNCING';

  const navItems: Array<{
    id: AppTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'planner', label: 'Planner', icon: Route },
    { id: 'hcps', label: `HCPs (${activeHcpsCount})`, icon: BriefcaseMedical },
    { id: 'import', label: 'Import', icon: Table2 },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#0F172A] text-[#0F172A] dark:text-[#F8FAFC] flex flex-col md:flex-row">
      {/* Desktop Compact Left Navigation Rail (exact same 4 items) */}
      <aside className="hidden md:flex md:flex-col md:w-[88px] lg:w-[216px] shrink-0 border-r border-[#E2E8F0] dark:border-[#334155] bg-white dark:bg-[#1E293B] sticky top-0 h-screen z-30">
        <button
          type="button"
          onClick={onOpenPoster}
          className="h-16 px-3 lg:px-4 flex items-center justify-center lg:justify-start gap-2.5 border-b border-[#E2E8F0] dark:border-[#334155] hover:bg-[#F1F5F9] dark:hover:bg-[#334155]/50 transition-colors"
          title="Open Territory Rx Welcome Poster"
        >
          <PharmacyBadgeIcon className="w-[34px] h-[34px]" />
          <span className="hidden lg:inline text-base font-extrabold tracking-tight text-[#0F172A] dark:text-[#F8FAFC]">
            Territory <span className="text-[#2563EB] dark:text-[#60A5FA]">Rx</span>
          </span>
        </button>

        <nav className="flex-1 p-2.5 space-y-1.5" aria-label="Primary navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`w-full min-h-[50px] flex flex-col lg:flex-row items-center justify-center lg:justify-start gap-1 lg:gap-3 px-2 lg:px-3.5 py-2 rounded-2xl text-xs lg:text-sm font-semibold transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#60A5FA]'
                    : 'text-[#475569] dark:text-[#CBD5E1] hover:bg-[#F1F5F9] dark:hover:bg-[#334155]/60'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                <span className="tabular-nums">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-[#E2E8F0] dark:border-[#334155] flex items-center justify-center">
          <button
            type="button"
            onClick={handleToggleTheme}
            className="w-full min-h-[42px] rounded-xl bg-[#F1F5F9] dark:bg-[#334155]/60 hover:bg-[#E2E8F0] dark:hover:bg-[#334155] text-xs font-semibold text-[#0F172A] dark:text-[#F8FAFC] inline-flex items-center justify-center gap-2"
            aria-label="Toggle theme"
          >
            {isDarkActive ? (
              <Sun className="w-4 h-4 text-[#60A5FA]" />
            ) : (
              <Moon className="w-4 h-4 text-[#2563EB]" />
            )}
            <span className="hidden lg:inline">{isDarkActive ? 'Light Mode' : 'Dark Mode'}</span>
          </button>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        {/* Center-Aligned Material 3 Top App Bar (matches Android screenshots 1:1) */}
        <header className="sticky top-0 z-30 h-16 px-4 bg-[#F8FAFC]/95 dark:bg-[#0F172A]/95 backdrop-blur-md border-b border-[#E2E8F0]/70 dark:border-[#1E293B] flex items-center justify-between pt-safe">
          {/* Left Spacer / Working Pill */}
          <div className="w-24 flex items-center justify-start">
            {showWorkingPill && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#60A5FA] px-2.5 py-1 text-[11px] font-semibold">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Working...</span>
              </span>
            )}
          </div>

          {/* Center Clickable Logo + Title (tapping re-opens Opening Poster) */}
          <button
            type="button"
            onClick={onOpenPoster}
            className="inline-flex items-center gap-2.5 px-2 py-1 rounded-2xl hover:bg-[#F1F5F9] dark:hover:bg-[#1E293B] transition-colors"
            title="Tap to view Opening Poster"
          >
            <PharmacyBadgeIcon className="w-[34px] h-[34px]" />
            <span className="text-[19px] font-bold tracking-tight text-[#0F172A] dark:text-[#F8FAFC] whitespace-nowrap">
              {TOP_TITLES[activeTab]}
            </span>
          </button>

          {/* Right Action: Theme Toggle */}
          <div className="w-24 flex items-center justify-end">
            <button
              type="button"
              onClick={handleToggleTheme}
              className="w-10 h-10 rounded-full inline-flex items-center justify-center text-[#2563EB] dark:text-[#60A5FA] hover:bg-[#DBEAFE]/60 dark:hover:bg-[#1E3A8A]/50 transition-colors"
              aria-label="Toggle Light/Dark theme"
              title="Toggle Light / Dark mode"
            >
              {isDarkActive ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        </header>

        {/* Offline Connectivity Strip */}
        {!isOnline && (
          <div className="bg-[#D97706] text-white px-4 py-1.5 text-xs font-medium flex items-center justify-center gap-2">
            <WifiOff className="w-3.5 h-3.5 shrink-0" />
            <span>Offline — IndexedDB cache active. Changes sync automatically when back online.</span>
          </div>
        )}

        {/* Mobile-First Centered Canvas (max-w-[560px] matching Android Material 3 feed) */}
        <main className="flex-1 w-full max-w-[560px] mx-auto px-3.5 sm:px-4 pt-3 pb-28 md:pb-12">
          {children}
        </main>
      </div>

      {/* Floating Bottom Status Toast Banner (rounded-[18px], Emerald / Crimson, auto-dismisses 3s) */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          onClick={onDismissToast}
          className={`fixed left-1/2 -translate-x-1/2 bottom-[84px] md:bottom-6 z-50 w-[calc(100%-28px)] max-w-[520px] rounded-[18px] px-4 py-3 text-sm font-semibold text-white shadow-xl flex items-center gap-2.5 cursor-pointer transition-all ${
            toast.type === 'success' ? 'bg-[#0F766E]' : 'bg-[#DC2626]'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 shrink-0" />
          )}
          <span className="flex-1 leading-snug">{toast.text}</span>
        </div>
      )}

      {/* Mobile Bottom Navigation Bar (4 tabs ONLY, exact Material 3 active pill indicator) */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-[#1E293B] border-t border-[#E2E8F0] dark:border-[#334155] pb-safe"
        aria-label="Bottom navigation"
      >
        <div className="max-w-[560px] mx-auto grid grid-cols-4 h-[70px]">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className="flex flex-col items-center justify-center gap-1 min-h-[48px] transition-colors"
              >
                <span
                  className={`flex items-center justify-center w-16 h-8 rounded-full transition-colors ${
                    isActive
                      ? 'bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#60A5FA]'
                      : 'text-[#475569] dark:text-[#CBD5E1]'
                  }`}
                >
                  <Icon className="w-[20px] h-[20px]" />
                </span>
                <span
                  className={`text-[11px] leading-none tabular-nums ${
                    isActive
                      ? 'font-bold text-[#2563EB] dark:text-[#60A5FA]'
                      : 'font-medium text-[#475569] dark:text-[#CBD5E1]'
                  }`}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
};
