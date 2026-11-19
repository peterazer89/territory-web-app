import React, { useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  MapPin,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useTerritory } from '../context/TerritoryContext';
import { Clinic, ClinicWindow, GeocodingStatus, Hcp } from '../types/territory';
import {
  daysBetweenIso,
  formatMinuteOfDay,
  getIsoDayLabel,
  getQuarterLabel,
  ISO_DAYS,
  minutesToTimeInput,
  parseTimeInputToMinutes,
  todayIso,
} from '../lib/dateUtils';
import {
  buildGoogleMapsPinUrl,
  isValidCoordinatePair,
} from '../lib/geoUtils';
import {
  buildClinicOpenMapsUrl,
  extractCoordinates,
  getEffectiveClinicCoordinates,
} from '../utils/gpsLocationParser';
import {
  classifyScheduleResult,
  EGYPTIAN_DAY_ORDER,
  formatCleanScheduleGroups,
  getEffectiveClinicWindows,
  parseSchedule,
  sortIsoDaysEgyptian,
} from '../utils/availabilityScheduleParser';
import {
  batchDeleteHcpsAndClinics,
  batchImportTerritoryData,
  clinicKeyFor,
  saveClinic,
  saveHcp,
} from '../lib/firestoreService';

interface HcpsTabProps {
  onToast: (text: string, type?: 'success' | 'error') => void;
  onBusyChange: (busy: boolean) => void;
}

type HcpFilterChip = 'ALL' | 'OVERDUE' | 'HIGH_RISK' | 'MULTI_CLINIC' | 'MISSING_DATA';

function getInitials(name: string): string {
  const parts = (name || '')
    .replace(/^(dr\.?|د\.?)\s*/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'DR';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const EGYPT_ORDERED_DAYS = EGYPTIAN_DAY_ORDER.map(
  (iso) => ISO_DAYS.find((d) => d.iso === iso)!
);

export const HcpsTab: React.FC<HcpsTabProps> = ({ onToast, onBusyChange }) => {
  const { user, hcps, clinics, visits, settings } = useTerritory();

  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<HcpFilterChip>('ALL');
  const [bulkRemoveMode, setBulkRemoveMode] = useState(false);
  const [selectedForRemoval, setSelectedForRemoval] = useState<Set<string>>(new Set());

  // Editor modal state
  const [editingHcpId, setEditingHcpId] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [initialClinicTabIdx, setInitialClinicTabIdx] = useState<number>(0);

  const clinicsByHcp = useMemo(() => {
    const map = new Map<string, Clinic[]>();
    for (const c of clinics) {
      const list = map.get(c.hcpTargetId) || [];
      list.push(c);
      list.sort((a, b) => a.clinicIndex - b.clinicIndex);
      map.set(c.hcpTargetId, list);
    }
    return map;
  }, [clinics]);

  const hcpMetrics = useMemo(() => {
    const today = todayIso();
    const q = settings.currentQuarterLabel;
    const overdueDays = settings.overdueThresholdDays || 14;
    const map = new Map<
      string,
      { completed: number; target: number; remaining: number; isOverdue: boolean; isHighRisk: boolean }
    >();

    for (const h of hcps) {
      if (!h.isActive || h.isDeleted) continue;
      const base =
        !h.baselineQuarterLabel || h.baselineQuarterLabel === q
          ? h.importedBaselineVisits || 0
          : 0;
      const hcpCompletedVisits = visits.filter(
        (v) =>
          v.hcpTargetId === h.targetId &&
          v.status === 'COMPLETED' &&
          v.qualifiesForCoverage !== false
      );
      const qVisits = hcpCompletedVisits.filter((v) => !v.quarterLabel || v.quarterLabel === q);
      const completed = base + qVisits.length;
      const target = Math.max(1, h.quarterlyTarget || 8);
      const remaining = Math.max(0, target - completed);

      const lastDate = hcpCompletedVisits
        .map((v) => v.plannedDateIso)
        .sort()
        .pop();
      const daysSince = lastDate ? daysBetweenIso(lastDate, today) : 999;
      const isOverdue = remaining > 0 && daysSince >= overdueDays;
      const isHighRisk = target > 0 && completed / target < 0.5 && remaining >= 2;

      map.set(h.targetId, { completed, target, remaining, isOverdue, isHighRisk });
    }
    return map;
  }, [hcps, visits, settings.currentQuarterLabel, settings.overdueThresholdDays]);

  const activeHcps = useMemo(
    () => hcps.filter((h) => h.isActive && !h.isDeleted).sort((a, b) => a.name.localeCompare(b.name)),
    [hcps]
  );

  const territoryQuarterStats = useMemo(() => {
    let totalTarget = 0;
    let totalCompleted = 0;
    let totalRemaining = 0;
    for (const h of activeHcps) {
      const target = Math.max(1, h.quarterlyTarget || 8);
      const m = hcpMetrics.get(h.targetId);
      const completed = m?.completed ?? 0;
      const remaining = Math.max(0, target - completed);
      totalTarget += target;
      totalCompleted += completed;
      totalRemaining += remaining;
    }
    const coveragePct =
      totalTarget > 0 ? Math.min(100, Math.round((totalCompleted / totalTarget) * 100)) : 0;
    return { totalTarget, totalCompleted, totalRemaining, coveragePct };
  }, [activeHcps, hcpMetrics]);

  const chipCounts = useMemo(() => {
    let overdue = 0;
    let highRisk = 0;
    let multiClinic = 0;
    let missingData = 0;
    for (const h of activeHcps) {
      const m = hcpMetrics.get(h.targetId);
      const hClinics = clinicsByHcp.get(h.targetId) || [];
      if (m?.isOverdue) overdue++;
      if (m?.isHighRisk) highRisk++;
      if (hClinics.length >= 2) multiClinic++;
      const hasMissing =
        hClinics.length === 0 ||
        hClinics.some((c) => {
          const eff = getEffectiveClinicWindows(c);
          const geo = getEffectiveClinicCoordinates(c);
          return (
            !geo.isRoutable ||
            eff.parseStatus === 'AMBIGUOUS' ||
            eff.parseStatus === 'UNPARSED' ||
            eff.windows.length === 0
          );
        });
      if (hasMissing) missingData++;
    }
    return {
      all: activeHcps.length,
      overdue,
      highRisk,
      multiClinic,
      missingData,
    };
  }, [activeHcps, hcpMetrics, clinicsByHcp]);

  const filteredHcps = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeHcps.filter((h) => {
      const m = hcpMetrics.get(h.targetId);
      const hClinics = clinicsByHcp.get(h.targetId) || [];

      if (activeFilter === 'OVERDUE' && !m?.isOverdue) return false;
      if (activeFilter === 'HIGH_RISK' && !m?.isHighRisk) return false;
      if (activeFilter === 'MULTI_CLINIC' && hClinics.length < 2) return false;
      if (activeFilter === 'MISSING_DATA') {
        const hasMissing =
          hClinics.length === 0 ||
          hClinics.some((c) => {
            const eff = getEffectiveClinicWindows(c);
            const geo = getEffectiveClinicCoordinates(c);
            return (
              !geo.isRoutable ||
              eff.parseStatus === 'AMBIGUOUS' ||
              eff.parseStatus === 'UNPARSED' ||
              eff.windows.length === 0
            );
          });
        if (!hasMissing) return false;
      }

      if (!q) return true;
      return (
        h.name.toLowerCase().includes(q) ||
        h.specialty.toLowerCase().includes(q) ||
        h.zone.toLowerCase().includes(q) ||
        h.targetId.toLowerCase().includes(q) ||
        hClinics.some((c) => (c.zone || '').toLowerCase().includes(q))
      );
    });
  }, [activeHcps, hcpMetrics, clinicsByHcp, activeFilter, search]);

  const parsedOnTheFlyClinics = useMemo(() => {
    const list: Array<{ clinic: Clinic; parsed: ReturnType<typeof parseSchedule> }> = [];
    for (const h of activeHcps) {
      const hClinics = clinicsByHcp.get(h.targetId) || [];
      for (const c of hClinics) {
        const eff = getEffectiveClinicWindows(c);
        if (eff.parsedOnTheFly && eff.windows.length > 0) {
          const raw = (
            c.rawScheduleText ||
            c.originalExcelScheduleText ||
            c.originalLocationText ||
            ''
          ).trim();
          const parsed = parseSchedule(raw);
          if (parsed.windows.length > 0) {
            list.push({ clinic: c, parsed });
          }
        }
      }
    }
    return list;
  }, [activeHcps, clinicsByHcp]);

  const handleSaveAllParsedOnFly = async () => {
    if (!user || parsedOnTheFlyClinics.length === 0) return;
    onBusyChange(true);
    try {
      const clinicsToWrite: Array<Omit<Clinic, 'id'>> = parsedOnTheFlyClinics.map(
        ({ clinic, parsed }) => {
          const { id: _ignore, ...rest } = clinic;
          return {
            ...rest,
            rawScheduleText: rest.rawScheduleText || rest.originalExcelScheduleText || parsed.rawText,
            windows: parsed.windows,
            normalizedDaysCsv: parsed.normalizedDays.join(','),
            excludedDaysCsv: parsed.excludedDays.join(','),
            scheduleParseStatus: parsed.status,
            scheduleClassification: classifyScheduleResult(parsed),
            parsingMethod: 'DETERMINISTIC',
            validationStatus:
              parsed.status === 'PARSED_HIGH_CONFIDENCE' ? 'VALID' : 'NEEDS_REVIEW',
            scheduleAmbiguityReason: parsed.ambiguityReason,
          };
        }
      );
      await batchImportTerritoryData(user.uid, [], clinicsToWrite);
      onToast(`Saved parsed schedules for ${clinicsToWrite.length} clinic(s) to Cloud.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to save parsed schedules.', 'error');
    } finally {
      onBusyChange(false);
    }
  };

  const handleSaveParsedClinicOnFly = async (c: Clinic, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    const raw = (
      c.rawScheduleText ||
      c.originalExcelScheduleText ||
      c.originalLocationText ||
      ''
    ).trim();
    if (!raw) return;
    const parsed = parseSchedule(raw);
    if (parsed.windows.length === 0) {
      onToast(parsed.ambiguityReason || 'Could not parse hours.', 'error');
      return;
    }
    onBusyChange(true);
    try {
      const { id: _ignore, ...rest } = c;
      await saveClinic(user.uid, {
        ...rest,
        rawScheduleText: rest.rawScheduleText || rest.originalExcelScheduleText || parsed.rawText,
        windows: parsed.windows,
        normalizedDaysCsv: parsed.normalizedDays.join(','),
        excludedDaysCsv: parsed.excludedDays.join(','),
        scheduleParseStatus: parsed.status,
        scheduleClassification: classifyScheduleResult(parsed),
        parsingMethod: 'DETERMINISTIC',
        validationStatus: parsed.status === 'PARSED_HIGH_CONFIDENCE' ? 'VALID' : 'NEEDS_REVIEW',
        scheduleAmbiguityReason: parsed.ambiguityReason,
      });
      onToast(`Saved ${parsed.windows.length} parsed window(s) for ${c.label}.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not save parsed schedule.', 'error');
    } finally {
      onBusyChange(false);
    }
  };

  const handleRemoveSingleHcp = async (h: Hcp, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    onBusyChange(true);
    try {
      await saveHcp(user.uid, { ...h, isActive: false, isDeleted: true });
      onToast(`Removed ${h.name}.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to remove HCP.', 'error');
    } finally {
      onBusyChange(false);
    }
  };

  const handleConfirmBulkRemove = async () => {
    if (!user || selectedForRemoval.size === 0) return;
    onBusyChange(true);
    try {
      const targetIds = Array.from(selectedForRemoval);
      const hcpIds = activeHcps
        .filter((h) => targetIds.includes(h.targetId))
        .map((h) => h.id);
      const clinicIds = clinics
        .filter((c) => targetIds.includes(c.hcpTargetId))
        .map((c) => c.id);
      await batchDeleteHcpsAndClinics(user.uid, hcpIds, clinicIds);
      onToast(`Removed ${hcpIds.length} HCP(s) and ${clinicIds.length} clinic(s).`);
      setSelectedForRemoval(new Set());
      setBulkRemoveMode(false);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Bulk removal failed.', 'error');
    } finally {
      onBusyChange(false);
    }
  };

  const toggleBulkSelect = (targetId: string) => {
    setSelectedForRemoval((prev) => {
      const next = new Set(prev);
      if (next.has(targetId)) next.delete(targetId);
      else next.add(targetId);
      return next;
    });
  };

  const editingHcp = editingHcpId
    ? hcps.find((h) => h.targetId === editingHcpId) || null
    : null;

  return (
    <div className="space-y-3.5">
      {/* 1. Search Bar (rounded-[12px], 48px) */}
      <div className="relative">
        <Search className="w-4 h-4 text-[#475569] dark:text-[#CBD5E1] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search Doctor, Specialty, or Brick..."
          dir="auto"
          className="w-full h-[48px] pl-10 pr-4 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] bg-white dark:bg-[#0F172A] text-sm text-[#0F172A] dark:text-[#F8FAFC] placeholder:text-[#64748B] dark:placeholder:text-[#94A3B8]"
        />
      </div>

      {/* 2. 2 Equal Action Buttons Row */}
      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => {
            setIsCreatingNew(true);
            setEditingHcpId(null);
            setInitialClinicTabIdx(0);
          }}
          className="h-[44px] rounded-[12px] bg-[#2563EB] dark:bg-[#60A5FA] hover:opacity-95 text-white dark:text-[#071633] text-sm font-bold inline-flex items-center justify-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          <span>Add HCP</span>
        </button>

        <button
          type="button"
          onClick={() => {
            if (bulkRemoveMode) {
              setBulkRemoveMode(false);
              setSelectedForRemoval(new Set());
            } else {
              setBulkRemoveMode(true);
            }
          }}
          className="h-[44px] rounded-[12px] bg-[#DC2626] hover:bg-[#B91C1C] text-white text-sm font-bold inline-flex items-center justify-center gap-1.5"
        >
          <Trash2 className="w-4 h-4" />
          <span>{bulkRemoveMode ? 'Cancel Remove' : 'Remove HCPs'}</span>
        </button>
      </div>

      {/* Bulk Remove Confirm Strip */}
      {bulkRemoveMode && (
        <div className="rounded-[16px] bg-[#DC2626]/12 border border-[#DC2626]/35 px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-xs font-bold text-[#DC2626] dark:text-red-300 tabular-nums">
            {selectedForRemoval.size} selected for deletion
          </span>
          <button
            type="button"
            disabled={selectedForRemoval.size === 0}
            onClick={() => void handleConfirmBulkRemove()}
            className="h-9 px-3.5 rounded-xl bg-[#DC2626] disabled:opacity-45 text-white text-xs font-bold"
          >
            Delete Selected
          </button>
        </div>
      )}

      {/* One-Tap Cloud Persist Strip for On-the-Fly Parsed Schedules */}
      {!bulkRemoveMode && parsedOnTheFlyClinics.length > 0 && (
        <div className="rounded-[16px] bg-[#DBEAFE]/70 dark:bg-[#1E3A8A]/45 border border-[#2563EB]/35 px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-[#0F172A] dark:text-[#F8FAFC] tabular-nums">
              {parsedOnTheFlyClinics.length} clinic schedule
              {parsedOnTheFlyClinics.length === 1 ? '' : 's'} parsed from text
            </p>
            <p className="text-[11px] text-[#475569] dark:text-[#CBD5E1]">
              Save structured visiting windows to sync with Planner &amp; Android
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSaveAllParsedOnFly()}
            className="shrink-0 h-9 px-3.5 rounded-xl bg-[#2563EB] dark:bg-[#60A5FA] text-white dark:text-[#071633] text-xs font-bold"
          >
            Save All
          </button>
        </div>
      )}

      {/* Territory Quarter Target & Coverage Summary Strip */}
      {activeHcps.length > 0 && (
        <div className="rounded-[16px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-[#0F172A] dark:text-[#F8FAFC]">
              {settings.currentQuarterLabel || 'Quarter'} Target:
            </span>
            <span className="px-2.5 py-0.5 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 text-[#2563EB] dark:text-[#93C5FD] font-bold">
              {territoryQuarterStats.totalCompleted}/{territoryQuarterStats.totalTarget} Visits ({territoryQuarterStats.coveragePct}%)
            </span>
          </div>
          <span className="text-[#0F766E] dark:text-[#2DD4BF] font-bold">
            {territoryQuarterStats.totalRemaining} Rem. Qtr
          </span>
        </div>
      )}

      {/* 3. Horizontal Scrollable Filter Chips */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {(
          [
            { id: 'ALL', label: `All (${chipCounts.all})` },
            { id: 'OVERDUE', label: `Overdue (${chipCounts.overdue})` },
            { id: 'HIGH_RISK', label: `High Coverage Risk (${chipCounts.highRisk})` },
            { id: 'MULTI_CLINIC', label: `Multi-Clinic (${chipCounts.multiClinic})` },
            { id: 'MISSING_DATA', label: `Missing Data (${chipCounts.missingData})` },
          ] as Array<{ id: HcpFilterChip; label: string }>
        ).map((chip) => {
          const active = activeFilter === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => setActiveFilter(chip.id)}
              className={`h-9 px-3.5 rounded-[12px] text-xs font-semibold border whitespace-nowrap tabular-nums transition-colors ${
                active
                  ? 'bg-[#0F766E] dark:bg-[#115E59] text-white border-transparent'
                  : 'bg-white dark:bg-[#0F172A] text-[#0F172A] dark:text-[#CBD5E1] border-[#CBD5E1] dark:border-[#475569]'
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* 4. HCP List Cards (rounded-[20px], 1px border) */}
      {filteredHcps.length === 0 ? (
        <div className="rounded-[20px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-8 text-center">
          <p className="text-sm font-bold text-[#0F172A] dark:text-[#F8FAFC]">No matching HCPs</p>
          <p className="mt-1 text-xs text-[#475569] dark:text-[#CBD5E1]">
            Try clearing your search filter, tapping + Add HCP, or importing an Excel workbook.
          </p>
        </div>
      ) : (
        <div className="space-y-3.5">
          {filteredHcps.map((h) => {
            const hClinics = clinicsByHcp.get(h.targetId) || [];
            const hTarget = Math.max(1, h.quarterlyTarget || 8);
            const metrics = hcpMetrics.get(h.targetId) || {
              completed: 0,
              target: hTarget,
              remaining: hTarget,
              isOverdue: false,
              isHighRisk: false,
            };
            const pct = Math.min(
              100,
              Math.round((metrics.completed / Math.max(1, hTarget)) * 100)
            );
            const isChecked = selectedForRemoval.has(h.targetId);

            return (
              <article
                key={h.id}
                onClick={() => {
                  if (bulkRemoveMode) {
                    toggleBulkSelect(h.targetId);
                  } else {
                    setIsCreatingNew(false);
                    setEditingHcpId(h.targetId);
                    setInitialClinicTabIdx(0);
                  }
                }}
                className={`rounded-[20px] bg-white dark:bg-[#1E293B] border p-4 space-y-3 cursor-pointer transition-colors ${
                  isChecked
                    ? 'border-[#DC2626] ring-1 ring-[#DC2626]/40'
                    : 'border-[#E2E8F0] dark:border-[#334155] hover:border-[#2563EB]/60'
                }`}
              >
                {/* Header Row: Initials Avatar + Doctor Name + Specialty • N Clinic */}
                <div className="flex items-center gap-3">
                  {bulkRemoveMode ? (
                    <span
                      className={`w-11 h-11 rounded-full border-2 inline-flex items-center justify-center shrink-0 ${
                        isChecked
                          ? 'bg-[#DC2626] border-[#DC2626] text-white'
                          : 'border-[#CBD5E1] dark:border-[#475569]'
                      }`}
                    >
                      {isChecked && <Check className="w-5 h-5" />}
                    </span>
                  ) : (
                    <span className="w-11 h-11 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A5F] text-[#0B2559] dark:text-[#E2E8F0] text-sm font-bold inline-flex items-center justify-center shrink-0">
                      {getInitials(h.name)}
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <h3
                      className="text-[16px] font-bold text-[#0F172A] dark:text-[#F8FAFC] truncate"
                      dir="auto"
                    >
                      {h.name}
                    </h3>
                    <p className="text-xs font-medium text-[#2563EB] dark:text-[#60A5FA] truncate">
                      {h.specialty || 'General'} • {hClinics.length}{' '}
                      {hClinics.length === 1 ? 'Clinic' : 'Clinics'}
                      <span className="ml-1.5 font-mono text-[11px] text-[#64748B] dark:text-[#94A3B8]">
                        {h.targetId}
                      </span>
                    </p>
                  </div>
                </div>

                {/* Progress Pill + Remove Button Row */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 border border-[#2563EB]/30 text-[#2563EB] dark:text-[#93C5FD] px-3 py-0.5 text-xs font-bold tabular-nums">
                      {metrics.completed}/{metrics.target} Visits
                    </span>
                    {metrics.isHighRisk && (
                      <span className="rounded-full bg-[#D97706]/15 text-[#D97706] dark:text-amber-400 px-2.5 py-0.5 text-[11px] font-bold">
                        High Risk
                      </span>
                    )}
                  </div>

                  {!bulkRemoveMode && (
                    <button
                      type="button"
                      onClick={(e) => void handleRemoveSingleHcp(h, e)}
                      className="h-8 px-3 rounded-[10px] border border-[#DC2626]/55 bg-[#DC2626]/10 hover:bg-[#DC2626]/20 text-[#DC2626] dark:text-red-400 text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Remove</span>
                    </button>
                  )}
                </div>

                {/* Progress Bar */}
                <div className="h-1.5 w-full rounded-full bg-[#0F766E]/25 dark:bg-[#115E59]/50 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#0F766E] dark:bg-[#2DD4BF] transition-all"
                    style={{ width: `${Math.max(pct, 2)}%` }}
                  />
                </div>

                {/* Independent Clinic 1 & Clinic 2 Rows */}
                <div className="space-y-2.5">
                  {hClinics.map((c, cIdx) => {
                    const effective = getEffectiveClinicWindows(c);
                    const grouped = formatCleanScheduleGroups(effective.windows);
                    const effectiveGeo = getEffectiveClinicCoordinates(c);
                    const mapsHref = buildClinicOpenMapsUrl({
                      googleMapsUrl: effectiveGeo.googleMapsUrl || c.googleMapsUrl,
                      latitude: effectiveGeo.latitude,
                      longitude: effectiveGeo.longitude,
                    });
                    const isValidSchedule =
                      (effective.parseStatus === 'CONFIRMED' ||
                        effective.parseStatus === 'PARSED_HIGH_CONFIDENCE') &&
                      effective.windows.length > 0;

                    return (
                      <div
                        key={c.id}
                        onClick={(e) => {
                          if (bulkRemoveMode) return;
                          e.stopPropagation();
                          setIsCreatingNew(false);
                          setEditingHcpId(h.targetId);
                          setInitialClinicTabIdx(cIdx);
                        }}
                        className="rounded-[14px] bg-[#F8FAFC] dark:bg-[#0F172A]/75 border border-[#E2E8F0] dark:border-[#334155] p-3 space-y-2"
                      >
                        {/* Top Clinic Row: Clinic N pill + Brick + Maps */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2 min-w-0 flex-1">
                            <span className="rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#93C5FD] px-2.5 py-0.5 text-[11px] font-bold shrink-0">
                              {c.label || `Clinic ${c.clinicIndex}`}
                            </span>
                            <div className="flex items-start gap-1 min-w-0 text-xs text-[#0F172A] dark:text-[#F8FAFC]">
                              <MapPin className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#60A5FA] shrink-0 mt-0.5" />
                              <span className="leading-snug break-words" dir="auto">
                                {c.zone || h.zone || 'No brick set'}
                              </span>
                            </div>
                          </div>

                          {mapsHref ? (
                            <a
                              href={mapsHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="h-7 px-2.5 rounded-lg border border-[#CBD5E1] dark:border-[#475569] text-[#2563EB] dark:text-[#60A5FA] text-[11px] font-bold inline-flex items-center gap-1 shrink-0 hover:bg-[#DBEAFE]/40"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span>Maps</span>
                            </a>
                          ) : (
                            <span className="rounded-lg bg-[#DC2626]/12 text-[#DC2626] dark:text-red-400 px-2 py-0.5 text-[11px] font-bold shrink-0">
                              No GPS
                            </span>
                          )}
                        </div>

                        {/* Schedule Summary + Valid / Review Pill */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2 min-w-0 text-xs">
                            <Clock className="w-3.5 h-3.5 text-[#0F766E] dark:text-[#2DD4BF] shrink-0 mt-0.5" />
                            <div className="space-y-1 text-[#0F172A] dark:text-[#F8FAFC]">
                              {grouped.length > 0 ? (
                                grouped.map((g, gi) => (
                                  <div key={gi} className="leading-snug">
                                    <p className="font-semibold">{g.days}</p>
                                    <p className="text-[#475569] dark:text-[#CBD5E1] tabular-nums">
                                      {g.range}
                                    </p>
                                  </div>
                                ))
                              ) : (
                                <div className="space-y-0.5">
                                  <p className="text-[#D97706] dark:text-amber-400" dir="auto">
                                    {c.rawScheduleText ||
                                      c.originalExcelScheduleText ||
                                      'No visiting hours yet — tap to edit or re-import'}
                                  </p>
                                  {effective.ambiguityReason &&
                                    (c.rawScheduleText || c.originalExcelScheduleText) && (
                                      <p className="text-[11px] text-[#64748B] dark:text-[#94A3B8]">
                                        {effective.ambiguityReason}
                                      </p>
                                    )}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                                isValidSchedule
                                  ? 'bg-[#0F766E]/15 text-[#0F766E] dark:text-[#2DD4BF]'
                                  : 'bg-[#D97706]/15 text-[#D97706] dark:text-amber-400'
                              }`}
                            >
                              {c.isManualUserConfirmed
                                ? 'Confirmed'
                                : isValidSchedule
                                  ? 'Valid'
                                  : 'Review'}
                            </span>

                            {effective.parsedOnTheFly && !bulkRemoveMode && (
                              <button
                                type="button"
                                onClick={(e) => void handleSaveParsedClinicOnFly(c, e)}
                                className="px-2 py-0.5 rounded-md bg-[#2563EB] text-white text-[10px] font-bold hover:opacity-90"
                              >
                                Save Parsed
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Schedule Details Footer */}
                        <div className="pt-1 flex items-center justify-between text-xs font-semibold text-[#2563EB] dark:text-[#60A5FA]">
                          <span>Schedule Details</span>
                          <ChevronDown className="w-4 h-4" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* 5. HCP Detail & Schedule Editor Modal */}
      {(editingHcp || isCreatingNew) && user && (
        <HcpDetailEditorModal
          userId={user.uid}
          hcp={editingHcp}
          existingClinics={editingHcp ? clinicsByHcp.get(editingHcp.targetId) || [] : []}
          initialClinicIndex={initialClinicTabIdx}
          defaultQuarter={settings.currentQuarterLabel || getQuarterLabel()}
          defaultVisitDuration={settings.defaultVisitDurationMinutes || 15}
          onClose={() => {
            setEditingHcpId(null);
            setIsCreatingNew(false);
          }}
          onToast={onToast}
          onBusyChange={onBusyChange}
        />
      )}
    </div>
  );
};

interface HcpDetailEditorModalProps {
  userId: string;
  hcp: Hcp | null;
  existingClinics: Clinic[];
  initialClinicIndex: number;
  defaultQuarter: string;
  defaultVisitDuration: number;
  onClose: () => void;
  onToast: (text: string, type?: 'success' | 'error') => void;
  onBusyChange: (busy: boolean) => void;
}

const HcpDetailEditorModal: React.FC<HcpDetailEditorModalProps> = ({
  userId,
  hcp,
  existingClinics,
  initialClinicIndex,
  defaultQuarter,
  defaultVisitDuration,
  onClose,
  onToast,
  onBusyChange,
}) => {
  const isCreate = !hcp;
  const [targetId] = useState(
    hcp?.targetId || `TRX-${Math.floor(1000 + Math.random() * 9000)}`
  );
  const [name, setName] = useState(hcp?.name || '');
  const [specialty, setSpecialty] = useState(hcp?.specialty || 'Cardiologist');
  const [qtrTarget, setQtrTarget] = useState(hcp?.quarterlyTarget ?? 8);
  const [priorVisits, setPriorVisits] = useState(hcp?.importedBaselineVisits ?? 0);
  const [quarterLabel, setQuarterLabel] = useState(hcp?.baselineQuarterLabel || defaultQuarter);

  // Editable clinic list
  const buildBlankClinic = (idx: number): Clinic => ({
    id: `clinic_${targetId}_C${idx}`,
    userId,
    clinicKey: clinicKeyFor(targetId, idx),
    hcpTargetId: targetId,
    clinicIndex: idx,
    label: `Clinic ${idx}`,
    zone: hcp?.zone || '',
    originalLocationText: '',
    googleMapsUrl: '',
    latitude: null,
    longitude: null,
    geocodingStatus: 'MISSING',
    rawScheduleText: '',
    originalExcelScheduleText: '',
    normalizedDaysCsv: '',
    excludedDaysCsv: '',
    scheduleParseStatus: 'UNPARSED',
    scheduleClassification: 'UNPARSED',
    parsingMethod: 'MANUAL',
    validationStatus: 'NEEDS_REVIEW',
    userConfirmedSchedule: false,
    isManualUserConfirmed: false,
    isActive: true,
    scheduleAmbiguityReason: '',
    sourceSheet: '',
    sourceRow: 0,
    sourceColumn: '',
    windows: [],
    version: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const [draftClinics, setDraftClinics] = useState<Clinic[]>(() =>
    existingClinics.length > 0
      ? existingClinics.map((c) => {
          const eff = getEffectiveClinicWindows(c);
          const geo = getEffectiveClinicCoordinates(c);
          return {
            ...c,
            latitude: geo.latitude,
            longitude: geo.longitude,
            googleMapsUrl: geo.googleMapsUrl || c.googleMapsUrl,
            geocodingStatus: geo.geocodingStatus,
            windows: [...eff.windows],
            scheduleParseStatus: eff.parsedOnTheFly ? eff.parseStatus : c.scheduleParseStatus,
          };
        })
      : [buildBlankClinic(1)]
  );
  const [activeClinicIdx, setActiveClinicIdx] = useState<number>(
    Math.min(initialClinicIndex, Math.max(0, existingClinics.length - 1))
  );

  // Weekday chip selection + time window adder
  const initialActive = draftClinics[Math.min(initialClinicIndex, Math.max(0, draftClinics.length - 1))];
  const [selectedDays, setSelectedDays] = useState<number[]>(() => {
    const days = Array.from(new Set((initialActive?.windows || []).map((w) => w.dayOfWeek)));
    return days.length > 0 ? sortIsoDaysEgyptian(days) : [6, 1, 3];
  });
  const [startTimeInput, setStartTimeInput] = useState(() =>
    initialActive?.windows?.[0]
      ? minutesToTimeInput(initialActive.windows[0].startMinuteOfDay)
      : '17:00'
  );
  const [endTimeInput, setEndTimeInput] = useState(() =>
    initialActive?.windows?.[0]
      ? minutesToTimeInput(initialActive.windows[0].endMinuteOfDay)
      : '21:00'
  );

  const activeClinic = draftClinics[activeClinicIdx] || draftClinics[0];

  const updateActiveClinic = (patch: Partial<Clinic>) => {
    setDraftClinics((prev) =>
      prev.map((c, idx) => (idx === activeClinicIdx ? { ...c, ...patch } : c))
    );
  };

  const handleAddClinicTab = () => {
    const nextNum = draftClinics.reduce((m, c) => Math.max(m, c.clinicIndex), 0) + 1;
    const nextClinic = buildBlankClinic(nextNum);
    setDraftClinics((prev) => [...prev, nextClinic]);
    setActiveClinicIdx(draftClinics.length);
  };

  const handleParseScheduleText = () => {
    const parsed = parseSchedule(activeClinic.rawScheduleText || '');
    const classification = classifyScheduleResult(parsed);
    const isValid =
      parsed.windows.length > 0 &&
      (parsed.status === 'PARSED_HIGH_CONFIDENCE' || parsed.status === 'CONFIRMED');

    updateActiveClinic({
      windows: parsed.windows,
      scheduleParseStatus: parsed.status,
      scheduleClassification: classification,
      scheduleAmbiguityReason: parsed.ambiguityReason,
      normalizedDaysCsv: parsed.normalizedDays.join(','),
      excludedDaysCsv: parsed.excludedDays.join(','),
      validationStatus: isValid ? 'VALID' : 'NEEDS_REVIEW',
      parsingMethod: 'DETERMINISTIC',
    });

    if (parsed.normalizedDays.length > 0) {
      setSelectedDays(parsed.normalizedDays);
    }
    if (parsed.windows.length > 0) {
      setStartTimeInput(minutesToTimeInput(parsed.windows[0].startMinuteOfDay));
      setEndTimeInput(minutesToTimeInput(parsed.windows[0].endMinuteOfDay));
      onToast(
        parsed.status === 'AMBIGUOUS'
          ? `Parsed ${parsed.windows.length} window(s) (Needs review: ${parsed.ambiguityReason})`
          : `Parsed ${parsed.windows.length} schedule window(s) for ${activeClinic.label}.`,
        parsed.status === 'AMBIGUOUS' ? 'error' : 'success'
      );
    } else {
      onToast(parsed.ambiguityReason || 'Could not parse hours — add windows manually.', 'error');
    }
  };

  const toggleDayChip = (iso: number) => {
    setSelectedDays((prev) =>
      prev.includes(iso) ? prev.filter((d) => d !== iso) : [...prev, iso]
    );
  };

  const handleExcludeSelectedDays = () => {
    const all = [1, 2, 3, 4, 5, 6, 7];
    setSelectedDays(all.filter((d) => !selectedDays.includes(d)));
  };

  const handleAddTimeWindows = () => {
    if (selectedDays.length === 0) {
      onToast('Select at least one weekday first.', 'error');
      return;
    }
    const startMin = parseTimeInputToMinutes(startTimeInput);
    const endMin = parseTimeInputToMinutes(endTimeInput);
    const endsNextDay = endMin <= startMin;
    const existing = [...(activeClinic.windows || [])];
    for (const day of selectedDays) {
      const exists = existing.some(
        (w) => w.dayOfWeek === day && w.startMinuteOfDay === startMin && w.endMinuteOfDay === endMin
      );
      if (!exists) {
        existing.push({
          dayOfWeek: day,
          startMinuteOfDay: startMin,
          endMinuteOfDay: endMin,
          endsNextDay,
          isConfirmed: Boolean(activeClinic.isManualUserConfirmed),
        });
      }
    }
    existing.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinuteOfDay - b.startMinuteOfDay);
    updateActiveClinic({
      windows: existing,
      scheduleParseStatus: 'PARSED_HIGH_CONFIDENCE',
      validationStatus: 'VALID',
      scheduleAmbiguityReason: '',
    });
  };

  const handleLocationInputChange = (rawVal: string) => {
    const extracted = extractCoordinates(
      rawVal,
      activeClinic.zone || '',
      activeClinic.clinicKey
    );
    const hasCoords = isValidCoordinatePair(extracted.latitude, extracted.longitude);
    updateActiveClinic({
      originalLocationText: rawVal,
      googleMapsUrl: extracted.googleMapsUrl || (/^https?:\/\//i.test(rawVal.trim()) ? rawVal.trim() : ''),
      latitude: hasCoords ? extracted.latitude : rawVal.trim() ? activeClinic.latitude : null,
      longitude: hasCoords ? extracted.longitude : rawVal.trim() ? activeClinic.longitude : null,
      geocodingStatus: hasCoords
        ? extracted.geocodingStatus
        : rawVal.trim()
          ? extracted.geocodingStatus
          : 'MISSING',
    });
  };

  const handleVerifyGps = () => {
    let lat = activeClinic.latitude;
    let lng = activeClinic.longitude;
    const rawText = (activeClinic.originalLocationText || activeClinic.googleMapsUrl || '').trim();
    let mapsUrl = (activeClinic.googleMapsUrl || '').trim();

    if (rawText) {
      const extracted = extractCoordinates(rawText, activeClinic.zone || '', activeClinic.clinicKey);
      if (isValidCoordinatePair(extracted.latitude, extracted.longitude)) {
        lat = extracted.latitude;
        lng = extracted.longitude;
        mapsUrl = extracted.googleMapsUrl || mapsUrl;
      }
    }

    if (!isValidCoordinatePair(lat, lng)) {
      onToast('Enter valid latitude/longitude or paste a Google Maps pin URL first.', 'error');
      return;
    }

    updateActiveClinic({
      latitude: Number(lat!.toFixed(6)),
      longitude: Number(lng!.toFixed(6)),
      googleMapsUrl: /^https?:\/\//i.test(mapsUrl) ? mapsUrl : buildGoogleMapsPinUrl(lat!, lng!),
      geocodingStatus: 'VERIFIED',
    });
    onToast(`${activeClinic.label} GPS verified & protected.`);
  };

  const handleConfirmSingleClinicSchedule = async () => {
    if (!name.trim()) {
      onToast('Enter Doctor Name first.', 'error');
      return;
    }
    onBusyChange(true);
    try {
      const confirmedWins = (activeClinic.windows || []).map((w) => ({ ...w, isConfirmed: true }));
      const updatedClinic: Clinic = {
        ...activeClinic,
        windows: confirmedWins,
        scheduleParseStatus: 'CONFIRMED',
        userConfirmedSchedule: true,
        isManualUserConfirmed: true,
        validationStatus: confirmedWins.length > 0 ? 'VALID' : 'NEEDS_REVIEW',
        parsingMethod: 'MANUAL',
        scheduleAmbiguityReason: '',
        normalizedDaysCsv: Array.from(new Set(confirmedWins.map((w) => w.dayOfWeek)))
          .sort((a, b) => a - b)
          .join(','),
      };
      updateActiveClinic(updatedClinic);
      await saveClinic(userId, updatedClinic);
      onToast(`Confirmed & saved ${updatedClinic.label} schedule.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not save clinic schedule.', 'error');
    } finally {
      onBusyChange(false);
    }
  };

  const handleSaveAll = async () => {
    if (!name.trim()) {
      onToast('Doctor Name is required.', 'error');
      return;
    }
    onBusyChange(true);
    try {
      const now = Date.now();
      const primaryZone = draftClinics[0]?.zone || hcp?.zone || '';
      await saveHcp(userId, {
        userId,
        targetId,
        name: name.trim(),
        specialty: specialty.trim() || 'General',
        quarterlyTarget: Math.max(1, Math.min(60, Math.round(Number(qtrTarget) || 8))),
        priorityScore: hcp?.priorityScore ?? 60,
        zone: primaryZone,
        isActive: true,
        defaultVisitDurationMinutes: hcp?.defaultVisitDurationMinutes || defaultVisitDuration,
        importedBaselineVisits: Math.max(0, Number(priorVisits) || 0),
        baselineQuarterLabel: quarterLabel.trim() || defaultQuarter,
        historyIncomplete: hcp?.historyIncomplete ?? false,
        notes: hcp?.notes || '',
        sourceWorkbook: hcp?.sourceWorkbook || 'MANUAL_WEB',
        version: hcp?.version ?? 0,
        isDeleted: false,
        createdAt: hcp?.createdAt ?? now,
        updatedAt: now,
      });

      for (const c of draftClinics) {
        let finalLat = c.latitude;
        let finalLng = c.longitude;
        let finalMapsUrl = (c.googleMapsUrl || '').trim();
        let geoStatus: GeocodingStatus = c.geocodingStatus || 'MISSING';

        const locRaw = (c.originalLocationText || c.googleMapsUrl || '').trim();
        if (locRaw && (!isValidCoordinatePair(finalLat, finalLng) || geoStatus === 'UNVERIFIED')) {
          const parsedGeo = extractCoordinates(locRaw, c.zone || '', c.clinicKey);
          if (isValidCoordinatePair(parsedGeo.latitude, parsedGeo.longitude)) {
            finalLat = parsedGeo.latitude;
            finalLng = parsedGeo.longitude;
            finalMapsUrl = parsedGeo.googleMapsUrl || finalMapsUrl;
            geoStatus = parsedGeo.geocodingStatus;
          } else {
            geoStatus = parsedGeo.geocodingStatus;
          }
        }

        const validCoords = isValidCoordinatePair(finalLat, finalLng);
        if (validCoords) {
          geoStatus =
            geoStatus === 'VERIFIED'
              ? 'VERIFIED'
              : /^https?:\/\//i.test(finalMapsUrl)
                ? 'EXTRACTED_URL'
                : 'VERIFIED';
        } else {
          geoStatus = locRaw ? 'UNVERIFIED' : 'MISSING';
        }

        const hasWindows = (c.windows || []).length > 0;
        const confirmedWindows = (c.windows || []).map((w) => ({ ...w, isConfirmed: true }));
        const { id: _ignoreId, ...clinicPayload } = c;
        await saveClinic(userId, {
          ...clinicPayload,
          hcpTargetId: targetId,
          clinicKey: clinicKeyFor(targetId, c.clinicIndex),
          originalLocationText: locRaw,
          googleMapsUrl: finalMapsUrl,
          latitude: validCoords ? Number(finalLat!.toFixed(6)) : null,
          longitude: validCoords ? Number(finalLng!.toFixed(6)) : null,
          geocodingStatus: geoStatus,
          windows: hasWindows ? confirmedWindows : [],
          scheduleParseStatus: hasWindows ? 'CONFIRMED' : c.scheduleParseStatus,
          userConfirmedSchedule: hasWindows ? true : Boolean(c.userConfirmedSchedule),
          isManualUserConfirmed: hasWindows ? true : Boolean(c.isManualUserConfirmed),
          validationStatus: hasWindows ? 'VALID' : 'NEEDS_REVIEW',
          scheduleAmbiguityReason: hasWindows ? '' : c.scheduleAmbiguityReason,
          normalizedDaysCsv: sortIsoDaysEgyptian(
            Array.from(new Set(confirmedWindows.map((w) => w.dayOfWeek)))
          ).join(','),
        });
      }

      onToast(isCreate ? `Added ${name.trim()}.` : `Saved changes for ${name.trim()}.`);
      onClose();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to save HCP.', 'error');
    } finally {
      onBusyChange(false);
    }
  };

  const handleArchive = async () => {
    if (!hcp) return;
    onBusyChange(true);
    try {
      await saveHcp(userId, { ...hcp, isActive: false, isDeleted: true });
      onToast(`Archived ${hcp.name}.`);
      onClose();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to archive HCP.', 'error');
    } finally {
      onBusyChange(false);
    }
  };

  const clinicMapsHref = buildClinicOpenMapsUrl({
    googleMapsUrl: activeClinic.googleMapsUrl,
    latitude: activeClinic.latitude,
    longitude: activeClinic.longitude,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/65 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="HCP Detail and Schedule Editor"
    >
      <div className="w-full max-w-[540px] max-h-[92vh] flex flex-col rounded-t-[26px] sm:rounded-[26px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-[#E2E8F0] dark:border-[#334155] flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-[#0F172A] dark:text-[#F8FAFC]">
              {isCreate ? 'Add New HCP' : 'HCP Detail & Schedule Editor'}
            </h2>
            <p className="text-[11px] font-mono text-[#64748B] dark:text-[#94A3B8]">{targetId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-[#475569] dark:text-[#CBD5E1]"
            aria-label="Close editor"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {/* Doctor Info Grid */}
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 block space-y-1">
              <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                Doctor Name
              </span>
              <input
                type="text"
                dir="auto"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Dr. Ahmed Farid"
                className="w-full h-11 px-3 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] bg-[#F8FAFC] dark:bg-[#0F172A] text-sm font-medium"
              />
            </label>

            <label className="col-span-2 block space-y-1">
              <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                Specialty
              </span>
              <input
                type="text"
                value={specialty}
                onChange={(e) => setSpecialty(e.target.value)}
                placeholder="Cardiologist"
                className="w-full h-10 px-3 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] bg-[#F8FAFC] dark:bg-[#0F172A] text-sm"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                Qtr Target
              </span>
              <input
                type="number"
                min={1}
                max={60}
                value={qtrTarget}
                onChange={(e) => setQtrTarget(Number(e.target.value))}
                className="w-full h-10 px-3 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] bg-[#F8FAFC] dark:bg-[#0F172A] text-sm tabular-nums"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                Prior Visits
              </span>
              <input
                type="number"
                min={0}
                max={60}
                value={priorVisits}
                onChange={(e) => setPriorVisits(Number(e.target.value))}
                className="w-full h-10 px-3 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] bg-[#F8FAFC] dark:bg-[#0F172A] text-sm tabular-nums"
              />
            </label>

            <label className="col-span-2 block space-y-1">
              <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                Quarter
              </span>
              <input
                type="text"
                value={quarterLabel}
                onChange={(e) => setQuarterLabel(e.target.value)}
                placeholder="2026-Q4"
                className="w-full h-10 px-3 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] bg-[#F8FAFC] dark:bg-[#0F172A] text-sm font-mono"
              />
            </label>
          </div>

          {/* Clinic Tabs ("Clinic 1 • Zone", "Clinic 2 • Zone", "+ Add Clinic") */}
          <div className="pt-2 border-t border-[#E2E8F0] dark:border-[#334155] space-y-3">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              {draftClinics.map((c, idx) => (
                <button
                  key={c.clinicKey}
                  type="button"
                  onClick={() => setActiveClinicIdx(idx)}
                  className={`h-9 px-3 rounded-full text-xs font-bold border whitespace-nowrap ${
                    idx === activeClinicIdx
                      ? 'bg-[#2563EB] text-white border-transparent'
                      : 'border-[#CBD5E1] dark:border-[#475569] text-[#475569] dark:text-[#CBD5E1]'
                  }`}
                >
                  {c.label} {c.zone ? `• ${c.zone}` : ''}
                </button>
              ))}
              <button
                type="button"
                onClick={handleAddClinicTab}
                className="h-9 px-3 rounded-full text-xs font-bold border border-dashed border-[#2563EB] text-[#2563EB] dark:text-[#60A5FA] whitespace-nowrap"
              >
                + Add Clinic
              </button>
            </div>

            {/* Active Clinic Editor Panel */}
            <div className="rounded-[18px] bg-[#F8FAFC] dark:bg-[#0F172A]/75 border border-[#E2E8F0] dark:border-[#334155] p-3.5 space-y-3.5">
              <label className="block space-y-1">
                <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                  Clinic Brick / Zone
                </span>
                <input
                  type="text"
                  dir="auto"
                  value={activeClinic.zone || ''}
                  onChange={(e) => updateActiveClinic({ zone: e.target.value })}
                  placeholder="e.g. العامرية / Maadi"
                  className="w-full h-10 px-3 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] bg-white dark:bg-[#1E293B] text-sm"
                />
              </label>

              {/* Visiting Time + Parse */}
              <div className="space-y-1">
                <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                  Visiting Time (EN / AR)
                </span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    dir="auto"
                    value={activeClinic.rawScheduleText || ''}
                    onChange={(e) => updateActiveClinic({ rawScheduleText: e.target.value })}
                    placeholder="Sat, Mon 2:00 PM - 6:00 PM"
                    className="flex-1 h-10 px-3 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] bg-white dark:bg-[#1E293B] text-xs"
                  />
                  <button
                    type="button"
                    onClick={handleParseScheduleText}
                    className="h-10 px-3.5 rounded-[12px] bg-[#2563EB] text-white text-xs font-bold shrink-0"
                  >
                    Parse
                  </button>
                </div>
              </div>

              {/* Weekday Chips + Select All / Exclude Selected */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-semibold text-[#475569] dark:text-[#CBD5E1]">Weekdays</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedDays([1, 2, 3, 4, 5, 6, 7])}
                      className="text-[#2563EB] dark:text-[#60A5FA] font-bold hover:underline"
                    >
                      Select All
                    </button>
                    <span aria-hidden="true" className="text-[#94A3B8]">•</span>
                    <button
                      type="button"
                      onClick={handleExcludeSelectedDays}
                      className="text-[#D97706] dark:text-amber-400 font-bold hover:underline"
                    >
                      Exclude Selected
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {EGYPT_ORDERED_DAYS.map((d) => {
                    const active = selectedDays.includes(d.iso);
                    return (
                      <button
                        key={d.iso}
                        type="button"
                        onClick={() => toggleDayChip(d.iso)}
                        className={`h-8 px-2.5 rounded-lg text-xs font-bold border ${
                          active
                            ? 'bg-[#0F766E] dark:bg-[#115E59] text-white border-transparent'
                            : 'bg-white dark:bg-[#1E293B] text-[#475569] dark:text-[#CBD5E1] border-[#CBD5E1] dark:border-[#475569]'
                        }`}
                      >
                        {d.short}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Start / Range + End + Add */}
              <div className="flex items-end gap-2">
                <label className="flex-1 block">
                  <span className="text-[11px] font-medium text-[#475569] dark:text-[#CBD5E1]">
                    Start / Range
                  </span>
                  <input
                    type="time"
                    value={startTimeInput}
                    onChange={(e) => setStartTimeInput(e.target.value)}
                    className="mt-0.5 w-full h-9 px-2.5 rounded-[10px] border border-[#CBD5E1] dark:border-[#475569] bg-white dark:bg-[#1E293B] text-xs font-mono"
                  />
                </label>
                <label className="flex-1 block">
                  <span className="text-[11px] font-medium text-[#475569] dark:text-[#CBD5E1]">
                    End
                  </span>
                  <input
                    type="time"
                    value={endTimeInput}
                    onChange={(e) => setEndTimeInput(e.target.value)}
                    className="mt-0.5 w-full h-9 px-2.5 rounded-[10px] border border-[#CBD5E1] dark:border-[#475569] bg-white dark:bg-[#1E293B] text-xs font-mono"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleAddTimeWindows}
                  className="h-9 px-3.5 rounded-[10px] bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#93C5FD] text-xs font-bold"
                >
                  Add
                </button>
              </div>

              {/* Parsed Windows List */}
              {(activeClinic.windows || []).length > 0 && (
                <div className="divide-y divide-[#E2E8F0] dark:divide-[#334155] rounded-[12px] border border-[#E2E8F0] dark:border-[#334155] bg-white dark:bg-[#1E293B] overflow-hidden">
                  {activeClinic.windows.map((w, wi) => (
                    <div
                      key={`${w.dayOfWeek}_${w.startMinuteOfDay}_${wi}`}
                      className="px-3 py-2 flex items-center justify-between text-xs tabular-nums"
                    >
                      <span>
                        <strong className="mr-2">{getIsoDayLabel(w.dayOfWeek, 'short')}</strong>
                        <span className="font-mono text-[#475569] dark:text-[#CBD5E1]">
                          {formatMinuteOfDay(w.startMinuteOfDay)} – {formatMinuteOfDay(w.endMinuteOfDay)}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          updateActiveClinic({
                            windows: activeClinic.windows.filter((_, idx) => idx !== wi),
                          })
                        }
                        className="p-1 text-[#DC2626]"
                        aria-label="Remove time window"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Confirm & Save Clinic N Schedule */}
              <button
                type="button"
                onClick={() => void handleConfirmSingleClinicSchedule()}
                className="w-full h-10 rounded-[12px] bg-[#0F766E] hover:bg-[#0D655E] text-white text-xs font-bold inline-flex items-center justify-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                <span>Confirm &amp; Save {activeClinic.label} Schedule</span>
              </button>

              {/* Google Maps URL or Address + Lat/Lng + Verify */}
              <div className="pt-3 border-t border-[#E2E8F0] dark:border-[#334155] space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                    Google Maps URL or Address
                  </span>
                  {clinicMapsHref && (
                    <a
                      href={clinicMapsHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-bold text-[#2563EB] dark:text-[#60A5FA] inline-flex items-center gap-1 hover:underline"
                    >
                      <span>Open Google Maps Link</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>

                <input
                  type="text"
                  value={activeClinic.originalLocationText || activeClinic.googleMapsUrl || ''}
                  onChange={(e) => handleLocationInputChange(e.target.value)}
                  placeholder="Paste Google Maps URL, maps.app.goo.gl, DMS, or lat, lng"
                  className="w-full h-10 px-3 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] bg-white dark:bg-[#1E293B] text-xs font-mono"
                />

                {isValidCoordinatePair(activeClinic.latitude, activeClinic.longitude) ? (
                  <p className="text-[11px] font-mono text-[#0F766E] dark:text-[#2DD4BF] tabular-nums">
                    {activeClinic.geocodingStatus === 'VERIFIED'
                      ? 'GPS Verified'
                      : 'Maps Link Resolved'}{' '}
                    • {activeClinic.latitude!.toFixed(5)}, {activeClinic.longitude!.toFixed(5)}
                  </p>
                ) : activeClinic.geocodingStatus === 'UNVERIFIED' ? (
                  <p className="text-[11px] text-[#D97706] dark:text-amber-400">
                    Location unverified — paste a Google Maps link or enter coordinates below.
                  </p>
                ) : null}

                <div className="flex items-end gap-2">
                  <label className="flex-1 block">
                    <span className="text-[11px] text-[#475569] dark:text-[#CBD5E1]">Latitude</span>
                    <input
                      type="text"
                      value={activeClinic.latitude ?? ''}
                      onChange={(e) =>
                        updateActiveClinic({
                          latitude: e.target.value.trim() ? Number(e.target.value) : null,
                        })
                      }
                      placeholder="31.2001"
                      className="mt-0.5 w-full h-9 px-2.5 rounded-[10px] border border-[#CBD5E1] dark:border-[#475569] bg-white dark:bg-[#1E293B] text-xs font-mono tabular-nums"
                    />
                  </label>
                  <label className="flex-1 block">
                    <span className="text-[11px] text-[#475569] dark:text-[#CBD5E1]">Longitude</span>
                    <input
                      type="text"
                      value={activeClinic.longitude ?? ''}
                      onChange={(e) =>
                        updateActiveClinic({
                          longitude: e.target.value.trim() ? Number(e.target.value) : null,
                        })
                      }
                      placeholder="29.9187"
                      className="mt-0.5 w-full h-9 px-2.5 rounded-[10px] border border-[#CBD5E1] dark:border-[#475569] bg-white dark:bg-[#1E293B] text-xs font-mono tabular-nums"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleVerifyGps}
                    className={`h-9 px-3.5 rounded-[10px] text-xs font-bold shrink-0 ${
                      activeClinic.geocodingStatus === 'VERIFIED'
                        ? 'bg-[#0F766E] text-white'
                        : 'bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#93C5FD]'
                    }`}
                  >
                    {activeClinic.geocodingStatus === 'VERIFIED' ? 'Verified ✓' : 'Verify'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions: Crimson Archive | Cancel | Primary Blue Save Changes */}
        <div className="px-4 py-3.5 border-t border-[#E2E8F0] dark:border-[#334155] flex items-center justify-between gap-2 bg-[#F8FAFC] dark:bg-[#0F172A]/60">
          {!isCreate ? (
            <button
              type="button"
              onClick={() => void handleArchive()}
              className="h-10 px-3.5 rounded-[12px] bg-[#DC2626] hover:bg-[#B91C1C] text-white text-xs font-bold"
            >
              Archive
            </button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] text-xs font-bold text-[#0F172A] dark:text-[#F8FAFC]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSaveAll()}
              className="h-10 px-4 rounded-[12px] bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold"
            >
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
