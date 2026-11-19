import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronDown,
  Cloud,
  Crosshair,
  Home,
  LogOut,
  Moon,
  RefreshCw,
  Save,
  SlidersHorizontal,
} from 'lucide-react';
import { useTerritory } from '../context/TerritoryContext';
import { ThemeMode } from '../types/territory';
import { getIsoDayLabel, ISO_DAYS } from '../lib/dateUtils';
import { isValidCoordinatePair } from '../lib/geoUtils';
import { EGYPT_ZONE_CENTROIDS, extractCoordinates } from '../utils/gpsLocationParser';
import { loadLocalPrefs, saveLocalPrefs } from '../lib/localPrefs';
import { PWAInstallButton } from './PWAInstallButton';

interface SettingsTabProps {
  onToast: (text: string, type?: 'success' | 'error') => void;
  onOpenPoster: () => void;
}

interface OutlinedNumberFieldProps {
  label: string;
  unit: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (val: number) => void;
}

const OutlinedNumberField: React.FC<OutlinedNumberFieldProps> = ({
  label,
  unit,
  value,
  min = 0,
  max = 999,
  onChange,
}) => (
  <label className="relative block pt-2">
    <span className="absolute left-3 top-0 px-1 text-[11px] font-medium bg-white dark:bg-[#1E293B] text-[#475569] dark:text-[#CBD5E1] z-10 leading-none">
      {label}
    </span>
    <div className="flex items-center h-[48px] px-3.5 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] focus-within:border-[#2563EB] dark:focus-within:border-[#60A5FA] bg-transparent transition-colors">
      <input
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full bg-transparent text-[14px] font-medium text-[#0F172A] dark:text-[#F8FAFC] tabular-nums focus:outline-none"
      />
      <span className="ml-2 text-[12px] font-medium text-[#475569] dark:text-[#CBD5E1] shrink-0">
        {unit}
      </span>
    </div>
  </label>
);

export const SettingsTab: React.FC<SettingsTabProps> = ({ onToast, onOpenPoster }) => {
  const {
    user,
    settings,
    syncState,
    isOnline,
    triggerManualSync,
    updateSettings,
    setThemeMode,
    signOut,
  } = useTerritory();

  // Workweek & Calendar state
  const [weekendDays, setWeekendDays] = useState<number[]>(settings.weekendDaysIso || [4, 5]);
  const [weekendDropdownOpen, setWeekendDropdownOpen] = useState(false);
  const [firstDayOfWeek, setFirstDayOfWeek] = useState<number>(settings.firstDayOfWeekIso || 6);

  // Route & Visit Rules state (Firestore-backed + LocalPrefs-backed)
  const [dailyTarget, setDailyTarget] = useState<number>(settings.dailyHcpTarget || 8);
  const [visitDuration, setVisitDuration] = useState<number>(
    settings.defaultVisitDurationMinutes || 15
  );
  const [sameClinicGap, setSameClinicGap] = useState<number>(0);
  const [trafficBuffer, setTrafficBuffer] = useState<number>(
    settings.trafficSafetyBufferPercent ?? 10
  );
  const [workdaysLeft, setWorkdaysLeft] = useState<number>(42);
  const [overdueAfter, setOverdueAfter] = useState<number>(settings.overdueThresholdDays || 14);

  const [homeAddress, setHomeAddress] = useState<string>(settings.homeAddress || '');
  const [homeLat, setHomeLat] = useState<number | null>(settings.homeLatitude ?? null);
  const [homeLng, setHomeLng] = useState<number | null>(settings.homeLongitude ?? null);
  const [returnHome, setReturnHome] = useState<boolean>(Boolean(settings.returnHomeRequired));
  const [blankCellsOverwrite, setBlankCellsOverwrite] = useState<boolean>(false);

  const [locatingHome, setLocatingHome] = useState(false);
  const [homeGpsError, setHomeGpsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setWeekendDays(settings.weekendDaysIso || [5]);
    setFirstDayOfWeek(settings.firstDayOfWeekIso || 6);
    setDailyTarget(settings.dailyHcpTarget || 8);
    setVisitDuration(settings.defaultVisitDurationMinutes || 15);
    setTrafficBuffer(settings.trafficSafetyBufferPercent ?? 10);
    setOverdueAfter(settings.overdueThresholdDays || 14);
    setHomeAddress(settings.homeAddress || '');
    setHomeLat(settings.homeLatitude ?? null);
    setHomeLng(settings.homeLongitude ?? null);
    setReturnHome(Boolean(settings.returnHomeRequired));
  }, [settings]);

  useEffect(() => {
    if (!user?.uid) return;
    const lp = loadLocalPrefs(user.uid);
    setSameClinicGap(lp.sameClinicGapMinutes);
    setWorkdaysLeft(lp.workdaysLeft);
    setBlankCellsOverwrite(lp.blankCellOverwritesVerified);
  }, [user?.uid]);

  const toggleWeekendDay = (isoDay: number) => {
    const next = weekendDays.includes(isoDay)
      ? weekendDays.filter((d) => d !== isoDay)
      : [...weekendDays, isoDay].sort((a, b) => a - b);
    setWeekendDays(next);
  };

  const handleFirstDayChange = async (isoDay: number) => {
    setFirstDayOfWeek(isoDay);
    try {
      await updateSettings({ firstDayOfWeekIso: isoDay });
      onToast(`First day of calendar week set to ${getIsoDayLabel(isoDay, 'full')}`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to update week start.', 'error');
    }
  };

  const handleHomeAddressChange = (val: string) => {
    setHomeAddress(val);
    setHomeGpsError(null);
    const extracted = extractCoordinates(val, val);
    if (extracted.latitude !== null && extracted.longitude !== null) {
      setHomeLat(extracted.latitude);
      setHomeLng(extracted.longitude);
    }
  };

  const handleSelectHomeZone = (zoneId: string) => {
    const entry = EGYPT_ZONE_CENTROIDS.find((z) => z.id === zoneId);
    if (!entry) return;
    setHomeGpsError(null);
    setHomeAddress(entry.label);
    setHomeLat(entry.latitude);
    setHomeLng(entry.longitude);
    onToast(`Home Base set to ${entry.label} — tap Save Settings to sync.`);
  };

  const handleUseCurrentHomeGps = () => {
    setHomeGpsError(null);
    if (!navigator.geolocation) {
      const msg =
        'Geolocation is not supported by this browser. Pick a starting Brick/Zone below or paste a Google Maps link.';
      setHomeGpsError(msg);
      onToast(msg, 'error');
      return;
    }
    setLocatingHome(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        setHomeLat(lat);
        setHomeLng(lng);
        if (!homeAddress.trim()) {
          setHomeAddress(`${lat}, ${lng}`);
        }
        setLocatingHome(false);
        onToast(`Home GPS pinned (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
      },
      (err) => {
        setLocatingHome(false);
        const msg =
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Pick a starting Brick/Zone below or paste a Google Maps link.'
            : err.message ||
              'Could not obtain current GPS location. Pick a starting Brick/Zone below or paste a Google Maps link.';
        setHomeGpsError(msg);
        onToast(msg, 'error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  };

  const handleSaveSettings = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const workingDaysIso = [1, 2, 3, 4, 5, 6, 7].filter((d) => !weekendDays.includes(d));
      const validHome = isValidCoordinatePair(homeLat, homeLng);

      saveLocalPrefs(user.uid, {
        sameClinicGapMinutes: Math.max(0, Math.min(180, Number(sameClinicGap) || 0)),
        workdaysLeft: Math.max(1, Math.min(92, Number(workdaysLeft) || 42)),
        blankCellOverwritesVerified: blankCellsOverwrite,
      });

      await updateSettings({
        dailyHcpTarget: Math.max(1, Math.min(20, Number(dailyTarget) || 8)),
        defaultVisitDurationMinutes: Math.max(5, Math.min(120, Number(visitDuration) || 15)),
        trafficSafetyBufferPercent: Math.max(0, Math.min(100, Number(trafficBuffer) || 0)),
        overdueThresholdDays: Math.max(1, Math.min(180, Number(overdueAfter) || 14)),
        firstDayOfWeekIso: firstDayOfWeek,
        weekendDaysIso: weekendDays,
        workingDaysIso,
        homeAddress: homeAddress.trim(),
        homeLatitude: validHome ? Number(homeLat!.toFixed(6)) : null,
        homeLongitude: validHome ? Number(homeLng!.toFixed(6)) : null,
        returnHomeRequired: returnHome,
        enforceWeeklyHcpVisitLimit: true,
      });

      onToast('Settings saved & synced to cloud.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to save settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleManualSyncClick = async () => {
    await triggerManualSync();
    if (navigator.onLine) {
      onToast('Cloud sync complete.');
    } else {
      onToast('Device is offline. Cached IndexedDB data remains active.', 'error');
    }
  };

  const weekendSummaryLabel =
    weekendDays.length > 0
      ? weekendDays.map((d) => getIsoDayLabel(d, 'full')).join(', ')
      : 'None selected';

  const firstDayName = getIsoDayLabel(firstDayOfWeek, 'full');

  return (
    <div className="space-y-4">
      {/* CARD 1: Appearance */}
      <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 text-[#2563EB] dark:text-[#60A5FA] flex items-center justify-center shrink-0">
              <Moon className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-[15px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-snug">
                Appearance
              </h2>
              <p className="text-[12px] text-[#475569] dark:text-[#CBD5E1] leading-snug">
                Theme mode &amp; welcome screen
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenPoster}
            className="shrink-0 h-[38px] px-3.5 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] text-[12px] font-semibold text-[#2563EB] dark:text-[#60A5FA] hover:bg-[#F1F5F9] dark:hover:bg-[#334155]/60 whitespace-nowrap"
          >
            Opening Page
          </button>
        </div>

        {/* 3-Way Segmented Control */}
        <div className="grid grid-cols-3 rounded-full border border-[#CBD5E1] dark:border-[#475569] overflow-hidden divide-x divide-[#CBD5E1] dark:divide-[#475569]">
          {(
            [
              { id: 'SYSTEM', label: 'System' },
              { id: 'LIGHT', label: 'Light' },
              { id: 'DARK', label: 'Dark' },
            ] as Array<{ id: ThemeMode; label: string }>
          ).map((item) => {
            const active = settings.themeMode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void setThemeMode(item.id)}
                className={`h-[40px] text-[13px] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors ${
                  active
                    ? 'bg-[#0F766E] dark:bg-[#0F5E58] text-white dark:text-[#CCFBF1]'
                    : 'bg-transparent text-[#0F172A] dark:text-[#F8FAFC] hover:bg-[#F1F5F9] dark:hover:bg-[#334155]/50'
                }`}
              >
                {active && <Check className="w-3.5 h-3.5" />}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* CARD 2: Workweek & Calendar */}
      <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-3.5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 text-[#2563EB] dark:text-[#60A5FA] flex items-center justify-center shrink-0">
            <Calendar className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-snug">
              Workweek &amp; Calendar
            </h2>
            <p className="text-[12px] text-[#475569] dark:text-[#CBD5E1] leading-snug">
              Choose weekend days and week start
            </p>
          </div>
        </div>

        {/* Weekend Days Multi-Select */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
              Weekend Days
            </span>
            <span className="px-2.5 py-0.5 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 text-[#2563EB] dark:text-[#60A5FA] text-[11px] font-bold tabular-nums">
              {weekendDays.length} off
            </span>
          </div>

          <button
            type="button"
            onClick={() => setWeekendDropdownOpen((v) => !v)}
            className="w-full min-h-[46px] px-3.5 rounded-[14px] bg-[#F8FAFC] dark:bg-[#0F172A]/60 border border-[#E2E8F0] dark:border-[#334155] flex items-center justify-between gap-2 text-left"
          >
            <span className="text-[13px] font-medium text-[#0F172A] dark:text-[#F8FAFC] truncate">
              {weekendSummaryLabel}
            </span>
            <ChevronDown
              className={`w-4 h-4 text-[#475569] dark:text-[#CBD5E1] shrink-0 transition-transform ${
                weekendDropdownOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {weekendDropdownOpen && (
            <div className="rounded-[14px] bg-[#F8FAFC] dark:bg-[#0F172A]/80 border border-[#E2E8F0] dark:border-[#334155] p-2 grid grid-cols-2 gap-1.5">
              {ISO_DAYS.map((day) => {
                const checked = weekendDays.includes(day.iso);
                return (
                  <button
                    key={day.iso}
                    type="button"
                    onClick={() => toggleWeekendDay(day.iso)}
                    className={`h-[36px] px-2.5 rounded-[10px] text-[12px] font-medium flex items-center gap-2 transition-colors ${
                      checked
                        ? 'bg-[#0F766E]/15 text-[#0F766E] dark:text-[#2DD4BF]'
                        : 'text-[#0F172A] dark:text-[#F8FAFC] hover:bg-[#E2E8F0]/50 dark:hover:bg-[#334155]/50'
                    }`}
                  >
                    <span
                      className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                        checked
                          ? 'bg-[#0F766E] border-[#0F766E] text-white'
                          : 'border-[#94A3B8] dark:border-[#64748B]'
                      }`}
                    >
                      {checked && <Check className="w-3 h-3" />}
                    </span>
                    <span>{day.full}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* First Day of Calendar Week */}
        <div className="space-y-2">
          <span className="text-[12px] font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
            First Day of Calendar Week
          </span>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { iso: 7, label: 'Sunday' },
                { iso: 6, label: 'Saturday' },
                { iso: 1, label: 'Monday' },
              ] as Array<{ iso: number; label: string }>
            ).map((opt) => {
              const active = firstDayOfWeek === opt.iso;
              return (
                <button
                  key={opt.iso}
                  type="button"
                  onClick={() => void handleFirstDayChange(opt.iso)}
                  className={`h-[38px] rounded-[11px] text-[12px] font-semibold border transition-colors ${
                    active
                      ? 'bg-[#0F766E] dark:bg-[#0F5E58] border-[#0F766E] text-white dark:text-[#CCFBF1]'
                      : 'bg-transparent border-[#CBD5E1] dark:border-[#475569] text-[#0F172A] dark:text-[#F8FAFC]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tinted Blue Info Box: Weekly Visit Frequency */}
        <div className="rounded-[16px] bg-[#DBEAFE]/55 dark:bg-[#1E3A8A]/35 border border-[#2563EB]/25 dark:border-[#60A5FA]/30 p-3.5 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-bold text-[#2563EB] dark:text-[#60A5FA]">
              Weekly Visit Frequency
            </span>
            <span className="shrink-0 px-2.5 py-0.5 rounded-full bg-[#0F766E]/15 text-[#0F766E] dark:text-[#2DD4BF] text-[10px] font-semibold">
              Mandatory Rule Active
            </span>
          </div>
          <p className="text-[12px] text-[#0F172A] dark:text-[#F8FAFC] leading-snug">
            Each HCP can be scheduled only once per calendar week, regardless of clinic.
          </p>
          <p className="text-[11px] text-[#475569] dark:text-[#CBD5E1] leading-snug">
            First day of the week: {firstDayName} • Weekly restriction is enabled by default across
            all clinics.
          </p>
        </div>
      </section>

      {/* CARD 3: Route & Visit Rules */}
      <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 text-[#2563EB] dark:text-[#60A5FA] flex items-center justify-center shrink-0">
            <SlidersHorizontal className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-snug">
              Route &amp; Visit Rules
            </h2>
            <p className="text-[12px] text-[#475569] dark:text-[#CBD5E1] leading-snug">
              Targets, visit buffers &amp; home base
            </p>
          </div>
        </div>

        {/* 2-Column Material Outlined Numeric Inputs */}
        <div className="grid grid-cols-2 gap-3">
          <OutlinedNumberField
            label="Daily Target"
            unit="HCPs"
            value={dailyTarget}
            min={1}
            max={20}
            onChange={setDailyTarget}
          />
          <OutlinedNumberField
            label="Visit Duration"
            unit="min"
            value={visitDuration}
            min={5}
            max={120}
            onChange={setVisitDuration}
          />
          <OutlinedNumberField
            label="Same-Clinic Gap"
            unit="min"
            value={sameClinicGap}
            min={0}
            max={180}
            onChange={setSameClinicGap}
          />
          <OutlinedNumberField
            label="Traffic Buffer"
            unit="%"
            value={trafficBuffer}
            min={0}
            max={100}
            onChange={setTrafficBuffer}
          />
          <OutlinedNumberField
            label="Workdays Left"
            unit="d"
            value={workdaysLeft}
            min={1}
            max={92}
            onChange={setWorkdaysLeft}
          />
          <OutlinedNumberField
            label="Overdue After"
            unit="d"
            value={overdueAfter}
            min={1}
            max={180}
            onChange={setOverdueAfter}
          />
        </div>

        {/* Full-Width Home Base Address */}
        <div className="space-y-1">
          <label className="relative block pt-2">
            <span className="absolute left-3 top-0 px-1 text-[11px] font-medium bg-white dark:bg-[#1E293B] text-[#475569] dark:text-[#CBD5E1] z-10 leading-none">
              Home Base Address
            </span>
            <div className="flex items-center h-[48px] px-3.5 gap-2.5 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] focus-within:border-[#2563EB] dark:focus-within:border-[#60A5FA]">
              <Home className="w-4 h-4 text-[#2563EB] dark:text-[#60A5FA] shrink-0" />
              <input
                type="text"
                dir="auto"
                value={homeAddress}
                onChange={(e) => handleHomeAddressChange(e.target.value)}
                placeholder="City, district, or paste Google Maps URL"
                className="w-full bg-transparent text-[13px] font-medium text-[#0F172A] dark:text-[#F8FAFC] focus:outline-none"
              />
              <button
                type="button"
                disabled={locatingHome}
                onClick={handleUseCurrentHomeGps}
                title="Use current GPS"
                className="p-1.5 rounded-lg text-[#0F766E] dark:text-[#2DD4BF] hover:bg-[#0F766E]/10 disabled:opacity-50 shrink-0"
              >
                <Crosshair className={`w-4 h-4 ${locatingHome ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </label>
          {isValidCoordinatePair(homeLat, homeLng) && (
            <p className="text-[11px] font-mono text-[#0F766E] dark:text-[#2DD4BF] pl-1 tabular-nums">
              GPS pinned: {homeLat!.toFixed(5)}, {homeLng!.toFixed(5)}
            </p>
          )}
          {homeGpsError && (
            <p className="text-[11px] text-[#D97706] dark:text-amber-400 pl-1 leading-snug">
              {homeGpsError}
            </p>
          )}
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) handleSelectHomeZone(e.target.value);
            }}
            aria-label="Pick starting Brick or Zone for Home Base"
            className="w-full h-[38px] px-3 rounded-[10px] border border-[#E2E8F0] dark:border-[#334155] bg-[#F8FAFC] dark:bg-[#0F172A]/60 text-[12px] text-[#475569] dark:text-[#CBD5E1]"
          >
            <option value="">Quick pick Home Base Brick / Zone...</option>
            {EGYPT_ZONE_CENTROIDS.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </select>
        </div>

        {/* Material Toggle Switches */}
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
                Return-to-Home Leg
              </p>
              <p className="text-[11px] text-[#475569] dark:text-[#CBD5E1]">
                Include drive back home at end of shift
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={returnHome}
              onClick={() => setReturnHome((v) => !v)}
              className={`relative w-[50px] h-[30px] rounded-full transition-colors shrink-0 ${
                returnHome
                  ? 'bg-[#2563EB] dark:bg-[#60A5FA]'
                  : 'bg-[#CBD5E1] dark:bg-[#334155] border border-[#94A3B8] dark:border-[#64748B]'
              }`}
            >
              <span
                className={`absolute top-1/2 -translate-y-1/2 w-[22px] h-[22px] rounded-full transition-all shadow-xs ${
                  returnHome
                    ? 'right-1 bg-white dark:bg-[#071633]'
                    : 'left-1 bg-white dark:bg-[#94A3B8]'
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
                Blank Cells Overwrite
              </p>
              <p className="text-[11px] text-[#475569] dark:text-[#CBD5E1]">
                Allow blank Excel cells to clear verified hours
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={blankCellsOverwrite}
              onClick={() => setBlankCellsOverwrite((v) => !v)}
              className={`relative w-[50px] h-[30px] rounded-full transition-colors shrink-0 ${
                blankCellsOverwrite
                  ? 'bg-[#2563EB] dark:bg-[#60A5FA]'
                  : 'bg-[#CBD5E1] dark:bg-[#334155] border border-[#94A3B8] dark:border-[#64748B]'
              }`}
            >
              <span
                className={`absolute top-1/2 -translate-y-1/2 w-[22px] h-[22px] rounded-full transition-all shadow-xs ${
                  blankCellsOverwrite
                    ? 'right-1 bg-white dark:bg-[#071633]'
                    : 'left-1 bg-white dark:bg-[#94A3B8]'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Full-Width Save Settings Button */}
        <button
          type="button"
          disabled={saving}
          onClick={() => void handleSaveSettings()}
          className="w-full h-[48px] rounded-[14px] bg-[#2563EB] dark:bg-[#60A5FA] hover:opacity-95 disabled:opacity-60 text-white dark:text-[#071633] text-[14px] font-semibold inline-flex items-center justify-center gap-2 shadow-xs"
        >
          <Save className="w-4 h-4" />
          <span>{saving ? 'Saving Settings...' : 'Save Settings'}</span>
        </button>
      </section>

      {/* CARD 4: Cloud Sync & Account */}
      <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-3.5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 text-[#2563EB] dark:text-[#60A5FA] flex items-center justify-center shrink-0">
            <Cloud className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-snug">
              Cloud Sync &amp; Account
            </h2>
            <p className="text-[12px] text-[#475569] dark:text-[#CBD5E1] leading-snug">
              Offline-first sync &amp; session management
            </p>
          </div>
        </div>

        {syncState.errorMessage && (
          <div className="rounded-[12px] bg-[#DC2626]/10 border border-[#DC2626]/25 px-3 py-2 text-[12px] text-[#DC2626] dark:text-red-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{syncState.errorMessage}</span>
          </div>
        )}

        <div className="text-[11px] text-[#475569] dark:text-[#CBD5E1] flex flex-wrap items-center justify-between gap-1 px-0.5">
          <span className="truncate">{user?.email || 'Signed in'}</span>
          <span className="tabular-nums">
            {!isOnline
              ? 'Offline Cache Active'
              : syncState.status === 'SYNCING'
                ? 'Syncing...'
                : syncState.lastSyncedAt
                  ? `Synced ${syncState.lastSyncedAt.toLocaleTimeString()}`
                  : 'Cloud Ready'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            disabled={syncState.status === 'SYNCING'}
            onClick={() => void handleManualSyncClick()}
            className="h-[44px] rounded-[14px] bg-[#0F766E] dark:bg-[#0F5E58] hover:opacity-95 disabled:opacity-60 text-white dark:text-[#CCFBF1] text-[13px] font-semibold inline-flex items-center justify-center gap-2"
          >
            <RefreshCw
              className={`w-4 h-4 ${syncState.status === 'SYNCING' ? 'animate-spin' : ''}`}
            />
            <span>Sync Now</span>
          </button>

          <button
            type="button"
            onClick={() => void signOut()}
            className="h-[44px] rounded-[14px] border border-[#CBD5E1] dark:border-[#475569] hover:bg-[#F1F5F9] dark:hover:bg-[#334155]/60 text-[#2563EB] dark:text-[#60A5FA] text-[13px] font-semibold inline-flex items-center justify-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>
        </div>

        <div className="pt-1">
          <PWAInstallButton />
        </div>
      </section>
    </div>
  );
};
