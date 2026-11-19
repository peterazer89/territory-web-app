import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Building2,
  Calendar,
  CalendarX2,
  Car,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Crosshair,
  Home,
  Lock,
  Navigation,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Store,
  Unlock,
  X,
  XCircle,
} from 'lucide-react';
import { useTerritory } from '../context/TerritoryContext';
import { Clinic, DailyPlan, PlanStop, VisitStatus } from '../types/territory';
import {
  addDaysIso,
  formatDuration,
  formatMinuteOfDay,
  formatReadableDate,
  getIsoDayLabel,
  getIsoDayOfWeek,
  getQuarterLabel,
  getWeekBounds,
  getWeekDates,
  minutesToTimeInput,
  parseTimeInputToMinutes,
  todayIso,
} from '../lib/dateUtils';
import {
  buildGoogleMapsDirectionsUrl,
  buildMultiStopGoogleMapsUrl,
} from '../lib/geoUtils';
import { getEffectiveClinicWindows } from '../utils/availabilityScheduleParser';
import {
  EGYPT_ZONE_CENTROIDS,
  extractCoordinates,
  getEffectiveClinicCoordinates,
  isValidLatLng,
} from '../utils/gpsLocationParser';
import {
  optimizeDailyPlans,
  optimizeWeeklyPlans,
  recomputePlanFromStops,
} from '../lib/routeOptimizer';
import {
  commitPlanStopsWithLocks,
  saveDailyPlan,
  saveDailyPlanBatch,
  upsertVisitWithWeeklyLockTx,
  WeeklyLockConflictError,
} from '../lib/firestoreService';
import { loadLocalPrefs, saveLocalPrefs } from '../lib/localPrefs';

interface PlannerTabProps {
  onToast: (text: string, type?: 'success' | 'error') => void;
  onBusyChange: (busy: boolean) => void;
}

const SHIFT_PRESETS = [
  { label: '9 AM – 5 PM', start: 9 * 60, end: 17 * 60 },
  { label: '1 PM – 9 PM', start: 13 * 60, end: 21 * 60 },
  { label: '4 PM – 11 PM', start: 16 * 60, end: 23 * 60 },
  { label: 'All Day', start: 8 * 60, end: 23 * 60 + 30 },
];

const DURATION_CHIPS = [15, 20, 30];

export const PlannerTab: React.FC<PlannerTabProps> = ({ onToast, onBusyChange }) => {
  const { user, hcps, clinics, visits, weeklyLocks, plans, settings, updateSettings } =
    useTerritory();

  const [viewMode, setViewMode] = useState<'daily' | 'weekly'>('daily');
  const [selectedDate, setSelectedDate] = useState<string>(todayIso());
  const [zoneFilter, setZoneFilter] = useState<string>('ALL');
  const [targetOverride, setTargetOverride] = useState<number>(settings.dailyHcpTarget || 8);
  const [shiftStartMin, setShiftStartMin] = useState<number>(13 * 60);
  const [shiftEndMin, setShiftEndMin] = useState<number>(21 * 60);
  const [customFromTime, setCustomFromTime] = useState<string>('13:00');
  const [customToTime, setCustomToTime] = useState<string>('21:00');
  const [controlsExpanded, setControlsExpanded] = useState<boolean>(false);

  // Starting point (Live GPS / Brick / Google Maps URL) state
  const [locatingStart, setLocatingStart] = useState<boolean>(false);
  const [startGpsError, setStartGpsError] = useState<string | null>(null);
  const [startLocationInput, setStartLocationInput] = useState<string>(settings.homeAddress || '');

  const [activeVariantCode, setActiveVariantCode] = useState<string>('A');
  const [showComparePlans, setShowComparePlans] = useState<boolean>(false);
  const [editingDurationStopIdx, setEditingDurationStopIdx] = useState<number | null>(null);

  const [showAddHcpModal, setShowAddHcpModal] = useState<boolean>(false);
  const [addSearch, setAddSearch] = useState<string>('');
  const [addBrickFilter, setAddBrickFilter] = useState<string>('ALL');
  const [busyLocal, setBusyLocal] = useState<boolean>(false);

  useEffect(() => {
    setStartLocationInput(settings.homeAddress || '');
  }, [settings.homeAddress]);

  useEffect(() => {
    if (settings.dailyHcpTarget) setTargetOverride(settings.dailyHcpTarget);
  }, [settings.dailyHcpTarget]);

  useEffect(() => {
    if (!user) return;
    const prefs = loadLocalPrefs(user.uid);
    setShiftStartMin(prefs.shiftStartMinute);
    setShiftEndMin(prefs.shiftEndMinute);
    setCustomFromTime(minutesToTimeInput(prefs.shiftStartMinute));
    setCustomToTime(minutesToTimeInput(prefs.shiftEndMinute));
  }, [user]);

  const setBusy = (val: boolean) => {
    setBusyLocal(val);
    onBusyChange(val);
  };

  const weekBounds = useMemo(
    () => getWeekBounds(selectedDate, settings.firstDayOfWeekIso),
    [selectedDate, settings.firstDayOfWeekIso]
  );

  const weekDates = useMemo(
    () => getWeekDates(selectedDate, settings.firstDayOfWeekIso),
    [selectedDate, settings.firstDayOfWeekIso]
  );

  const workingWeekDates = useMemo(
    () => weekDates.filter((d) => !(settings.weekendDaysIso || []).includes(d.isoDay)),
    [weekDates, settings.weekendDaysIso]
  );

  const bricks = useMemo(() => {
    const s = new Set<string>();
    hcps.forEach((h) => {
      if (h.isActive && !h.isDeleted && h.zone?.trim()) s.add(h.zone.trim());
    });
    clinics.forEach((c) => {
      if (c.isActive && c.zone?.trim()) s.add(c.zone.trim());
    });
    return Array.from(s).sort();
  }, [hcps, clinics]);

  const clinicsByKey = useMemo(() => {
    const map = new Map<string, Clinic>();
    clinics.forEach((c) => map.set(c.clinicKey, c));
    return map;
  }, [clinics]);

  const clinicsByHcp = useMemo(() => {
    const map = new Map<string, Clinic[]>();
    clinics
      .filter((c) => c.isActive)
      .forEach((c) => {
        const list = map.get(c.hcpTargetId) || [];
        list.push(c);
        list.sort((a, b) => a.clinicIndex - b.clinicIndex);
        map.set(c.hcpTargetId, list);
      });
    return map;
  }, [clinics]);

  const completedCountByHcp = useMemo(() => {
    const map = new Map<string, number>();
    const q = settings.currentQuarterLabel;
    for (const v of visits) {
      if (
        v.status === 'COMPLETED' &&
        v.qualifiesForCoverage !== false &&
        (!v.quarterLabel || v.quarterLabel === q)
      ) {
        map.set(v.hcpTargetId, (map.get(v.hcpTargetId) || 0) + 1);
      }
    }
    return map;
  }, [visits, settings.currentQuarterLabel]);

  const remainingByHcp = useMemo(() => {
    const map = new Map<string, number>();
    let totalRem = 0;
    let totalTarget = 0;
    let totalCompleted = 0;
    for (const h of hcps) {
      if (!h.isActive || h.isDeleted) continue;
      const base =
        !h.baselineQuarterLabel || h.baselineQuarterLabel === settings.currentQuarterLabel
          ? h.importedBaselineVisits || 0
          : 0;
      const done = base + (completedCountByHcp.get(h.targetId) || 0);
      const target = Math.max(1, h.quarterlyTarget || 8);
      const rem = Math.max(0, target - done);
      map.set(h.targetId, rem);
      totalRem += rem;
      totalTarget += target;
      totalCompleted += done;
    }
    const coveragePct =
      totalTarget > 0 ? Math.min(100, Math.round((totalCompleted / totalTarget) * 100)) : 0;
    return { map, totalRem, totalTarget, totalCompleted, coveragePct };
  }, [hcps, completedCountByHcp, settings.currentQuarterLabel]);

  const plansForSelectedDate = useMemo(() => {
    return plans
      .filter((p) => p.dateIso === selectedDate)
      .sort((a, b) => a.variantCode.localeCompare(b.variantCode));
  }, [plans, selectedDate]);

  const activePlan: DailyPlan | null = useMemo(() => {
    if (plansForSelectedDate.length === 0) return null;
    const byCode = plansForSelectedDate.find((p) => p.variantCode === activeVariantCode);
    if (byCode) return byCode;
    return plansForSelectedDate.find((p) => p.isSelected) || plansForSelectedDate[0];
  }, [plansForSelectedDate, activeVariantCode]);

  const weekLocksForWeek = useMemo(() => {
    const map = new Map<string, (typeof weeklyLocks)[number]>();
    for (const lock of weeklyLocks) {
      if (
        lock.weekStartIso === weekBounds.weekStartIso &&
        (lock.status === 'PLANNED' || lock.status === 'COMPLETED' || lock.status === 'CONFIRMED')
      ) {
        map.set(lock.hcpTargetId, lock);
      }
    }
    return map;
  }, [weeklyLocks, weekBounds.weekStartIso]);

  const visitByHcpDate = useMemo(() => {
    const map = new Map<string, (typeof visits)[number]>();
    for (const v of visits) {
      map.set(`${v.hcpTargetId}__${v.plannedDateIso}`, v);
    }
    return map;
  }, [visits]);

  const selectedDayStats = useMemo(() => {
    const isoDay = getIsoDayOfWeek(selectedDate);
    const activeHcps = hcps.filter((h) => h.isActive && !h.isDeleted);
    let weeklyExcluded = 0;
    let eligible = 0;

    for (const h of activeHcps) {
      // Exclude doctors who have already reached their quarterly target
      if ((remainingByHcp.map.get(h.targetId) ?? 0) <= 0) {
        continue;
      }
      const lock = weekLocksForWeek.get(h.targetId);
      if (settings.enforceWeeklyHcpVisitLimit !== false && lock && lock.plannedDateIso !== selectedDate) {
        weeklyExcluded++;
        continue;
      }
      const hClinics = clinicsByHcp.get(h.targetId) || [];
      const hasOpenWindow = hClinics.some((c) => {
        if (zoneFilter !== 'ALL' && (c.zone || h.zone || '').trim() !== zoneFilter) return false;
        return getEffectiveClinicWindows(c).windows.some((w) => w.dayOfWeek === isoDay);
      });
      if (hasOpenWindow) eligible++;
    }

    const scheduleExcluded = Math.max(0, activeHcps.length - weeklyExcluded - eligible);
    return { eligible, weeklyExcluded, scheduleExcluded };
  }, [
    hcps,
    clinicsByHcp,
    weekLocksForWeek,
    remainingByHcp.map,
    selectedDate,
    zoneFilter,
    settings.enforceWeeklyHcpVisitLimit,
  ]);

  const fullRouteUrl = useMemo(() => {
    if (!activePlan || activePlan.stops.length === 0) return '';
    const resolvedStops = activePlan.stops.map((s) => {
      if (isValidLatLng(s.latitude, s.longitude)) return s;
      const clinic = clinicsByKey.get(s.clinicKey);
      if (!clinic) return s;
      const geo = getEffectiveClinicCoordinates(clinic);
      return { ...s, latitude: geo.latitude, longitude: geo.longitude };
    });
    return buildMultiStopGoogleMapsUrl(
      resolvedStops,
      settings.homeLatitude,
      settings.homeLongitude,
      settings.returnHomeRequired
    );
  }, [activePlan, clinicsByKey, settings.homeLatitude, settings.homeLongitude, settings.returnHomeRequired]);

  const handleUseCurrentStartGps = () => {
    setStartGpsError(null);
    if (!navigator.geolocation) {
      const msg =
        'Geolocation is not supported here. Pick a starting Brick/Zone below or paste a Google Maps link.';
      setStartGpsError(msg);
      onToast(msg, 'error');
      return;
    }
    setLocatingStart(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        setLocatingStart(false);
        const label = `Current GPS (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
        setStartLocationInput(label);
        void updateSettings({
          homeAddress: label,
          homeLatitude: lat,
          homeLongitude: lng,
        })
          .then(() => onToast(`Starting GPS pinned (${lat.toFixed(4)}, ${lng.toFixed(4)})`))
          .catch((err) =>
            onToast(err instanceof Error ? err.message : 'Failed to save starting GPS.', 'error')
          );
      },
      (err) => {
        setLocatingStart(false);
        const msg =
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Pick a starting Brick/Zone below or paste a Google Maps link.'
            : err.message ||
              'Unable to read device GPS. Pick a starting Brick/Zone below or paste a Google Maps link.';
        setStartGpsError(msg);
        onToast(msg, 'error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  };

  const handlePickStartZone = async (zoneId: string) => {
    const entry = EGYPT_ZONE_CENTROIDS.find((z) => z.id === zoneId);
    if (!entry) return;
    setStartGpsError(null);
    setStartLocationInput(entry.label);
    try {
      await updateSettings({
        homeAddress: entry.label,
        homeLatitude: entry.latitude,
        homeLongitude: entry.longitude,
      });
      onToast(`Starting point set to ${entry.label}`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to set starting point.', 'error');
    }
  };

  const handleApplyStartLocationInput = async () => {
    const raw = startLocationInput.trim();
    if (!raw) return;
    setStartGpsError(null);
    const extracted = extractCoordinates(raw, raw);
    if (!isValidLatLng(extracted.latitude, extracted.longitude)) {
      const msg =
        'Could not extract coordinates from that link/text. Paste a Google Maps URL or pick a Brick/Zone.';
      setStartGpsError(msg);
      onToast(msg, 'error');
      return;
    }
    try {
      await updateSettings({
        homeAddress: raw,
        homeLatitude: extracted.latitude,
        homeLongitude: extracted.longitude,
      });
      onToast(
        `Starting point pinned (${extracted.latitude!.toFixed(4)}, ${extracted.longitude!.toFixed(4)})`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to save starting point.', 'error');
    }
  };

  const applyShiftTimes = (startMin: number, endMin: number) => {
    if (endMin <= startMin) {
      onToast('Shift end time must be after start time.', 'error');
      return;
    }
    setShiftStartMin(startMin);
    setShiftEndMin(endMin);
    setCustomFromTime(minutesToTimeInput(startMin));
    setCustomToTime(minutesToTimeInput(endMin));
    if (user) {
      saveLocalPrefs(user.uid, { shiftStartMinute: startMin, shiftEndMinute: endMin });
    }
  };

  const handleSetCustomShift = () => {
    const s = parseTimeInputToMinutes(customFromTime);
    const e = parseTimeInputToMinutes(customToTime);
    applyShiftTimes(s, e);
    onToast(`Shift hours set: ${formatMinuteOfDay(s)} – ${formatMinuteOfDay(e)}`);
  };

  const handleAiRoutePlan = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const generated = optimizeDailyPlans({
        userId: user.uid,
        dateIso: selectedDate,
        hcps,
        clinics,
        visits,
        weeklyLocks,
        settings,
        zoneFilter,
        targetOverride,
        shiftStartMinute: shiftStartMin,
        shiftEndMinute: shiftEndMin,
      });
      await saveDailyPlanBatch(user.uid, generated);
      setActiveVariantCode('A');
      const primary = generated[0];
      if (primary.feasibilityStatus === 'INFEASIBLE') {
        onToast(primary.infeasibilityReasonsText || 'No feasible stops fit this shift.', 'error');
      } else {
        onToast(
          `AI Route Plan ready: ${primary.plannedVisitsCount}/${targetOverride} visits in Plan A (${primary.totalDistanceKm.toFixed(1)} km).`
        );
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Route optimization failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateWeeklySchedule = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const result = optimizeWeeklyPlans({
        userId: user.uid,
        dateIso: selectedDate,
        hcps,
        clinics,
        visits,
        weeklyLocks,
        settings,
        zoneFilter,
        targetOverride,
        shiftStartMinute: shiftStartMin,
        shiftEndMinute: shiftEndMin,
      });
      if (result.allPlans.length > 0) {
        await saveDailyPlanBatch(user.uid, result.allPlans);
      }
      const total = Object.values(result.byDate).reduce(
        (sum, dayPlans) => sum + (dayPlans[0]?.plannedVisitsCount || 0),
        0
      );
      onToast(`Generated weekly schedule: ${total} unique HCP visits across working days.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Weekly generation failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSelectVariant = async (variantCode: string) => {
    setActiveVariantCode(variantCode);
    if (!user || plansForSelectedDate.length === 0) return;
    const updated = plansForSelectedDate.map((p) => ({
      ...p,
      isSelected: p.variantCode === variantCode,
    }));
    await saveDailyPlanBatch(user.uid, updated);
  };

  const persistEditedStops = async (nextStops: PlanStop[]) => {
    if (!user || !activePlan) return;
    const recomputed = recomputePlanFromStops({
      userId: user.uid,
      dateIso: activePlan.dateIso,
      variantCode: activePlan.variantCode,
      variantLabel: activePlan.variantLabel,
      isSelected: activePlan.isSelected,
      stops: nextStops,
      clinicsByKey,
      settings,
      targetVisits: targetOverride,
    });
    await saveDailyPlan(user.uid, recomputed);
  };

  const handleMoveStop = async (index: number, direction: -1 | 1) => {
    if (!activePlan) return;
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= activePlan.stops.length) return;
    const copy = [...activePlan.stops];
    const [moved] = copy.splice(index, 1);
    copy.splice(targetIdx, 0, moved);
    await persistEditedStops(copy);
  };

  const handleToggleLockStop = async (index: number) => {
    if (!activePlan) return;
    const copy = activePlan.stops.map((s, i) =>
      i === index ? { ...s, isLocked: !s.isLocked } : s
    );
    await persistEditedStops(copy);
  };

  const handleChangeStopDuration = async (index: number, minutes: number) => {
    if (!activePlan) return;
    const copy = activePlan.stops.map((s, i) =>
      i === index ? { ...s, visitDurationMinutes: minutes } : s
    );
    await persistEditedStops(copy);
    setEditingDurationStopIdx(null);
    onToast(`Visit duration updated to ${minutes}m.`);
  };

  const handleSwitchStopClinic = async (index: number, nextClinicKey: string) => {
    if (!activePlan) return;
    const clinic = clinicsByKey.get(nextClinicKey);
    if (!clinic) return;
    const geo = getEffectiveClinicCoordinates(clinic);
    const copy = activePlan.stops.map((s, i) =>
      i === index
        ? {
            ...s,
            clinicKey: clinic.clinicKey,
            clinicLabel: clinic.label,
            zone: clinic.zone || s.zone,
            latitude: geo.latitude,
            longitude: geo.longitude,
          }
        : s
    );
    await persistEditedStops(copy);
  };

  const handleStopStatusChange = async (stopIndex: number, nextStatus: VisitStatus) => {
    if (!user || !activePlan) return;
    const stop = activePlan.stops[stopIndex];
    if (!stop) return;
    setBusy(true);
    try {
      await upsertVisitWithWeeklyLockTx(user.uid, {
        hcpTargetId: stop.hcpTargetId,
        clinicKey: stop.clinicKey,
        clinicLabel: stop.clinicLabel,
        plannedDateIso: activePlan.dateIso,
        plannedStartMinute: stop.visitStartMinute,
        plannedEndMinute: stop.visitEndMinute,
        status: nextStatus,
        quarterLabel: settings.currentQuarterLabel || getQuarterLabel(activePlan.dateIso),
        firstDayOfWeekIso: settings.firstDayOfWeekIso,
        enforceWeeklyLimit: settings.enforceWeeklyHcpVisitLimit,
        recordSource: 'PLANNER_WEB',
      });

      const updatedStops = activePlan.stops.map((s, i) =>
        i === stopIndex
          ? {
              ...s,
              executionStatus: nextStatus,
              isLocked: nextStatus === 'PLANNED' || nextStatus === 'COMPLETED',
            }
          : s
      );
      await persistEditedStops(updatedStops);
      const label =
        nextStatus === 'COMPLETED'
          ? 'Completed'
          : nextStatus === 'CANCELLED'
            ? 'Cancelled'
            : nextStatus === 'NOT_COMPLETED'
              ? 'Missed'
              : 'Planned';
      onToast(`${stop.hcpName} marked ${label}.`);
    } catch (err) {
      if (err instanceof WeeklyLockConflictError) {
        onToast(err.message, 'error');
      } else {
        onToast(err instanceof Error ? err.message : 'Status update failed.', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCommitPlanLocks = async () => {
    if (!user || !activePlan || activePlan.stops.length === 0) return;
    setBusy(true);
    try {
      const { committedCount, conflicts } = await commitPlanStopsWithLocks(
        user.uid,
        activePlan,
        settings
      );
      const conflictSet = new Set(conflicts.map((c) => c.stop.hcpTargetId));
      const updatedStops = activePlan.stops.map((s) => ({
        ...s,
        isLocked:
          !conflictSet.has(s.hcpTargetId) &&
          (s.executionStatus === 'PLANNED' || s.executionStatus === 'COMPLETED'),
      }));
      await persistEditedStops(updatedStops);
      if (conflicts.length > 0) {
        onToast(
          `Committed ${committedCount} stops. ${conflicts.length} blocked by weekly lock.`,
          'error'
        );
      } else {
        onToast(`Committed ${committedCount} visits & weekly locks.`);
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Commit failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleManualAddStop = async (hcpTargetId: string, clinic: Clinic) => {
    if (!user) return;
    const hcp = hcps.find((h) => h.targetId === hcpTargetId);
    if (!hcp) return;

    const existingLock = weekLocksForWeek.get(hcp.targetId);
    if (
      settings.enforceWeeklyHcpVisitLimit !== false &&
      existingLock &&
      existingLock.plannedDateIso !== selectedDate
    ) {
      onToast(
        `${hcp.name} already has a visit this week (${existingLock.plannedDateIso}).`,
        'error'
      );
      return;
    }

    const existingStops = activePlan?.stops || [];
    if (existingStops.some((s) => s.hcpTargetId === hcp.targetId)) {
      onToast(`${hcp.name} is already in today's route.`, 'error');
      return;
    }

    const duration = hcp.defaultVisitDurationMinutes || settings.defaultVisitDurationMinutes || 15;
    const clinicGeo = getEffectiveClinicCoordinates(clinic);
    const newStop: PlanStop = {
      stopOrder: existingStops.length + 1,
      hcpTargetId: hcp.targetId,
      hcpName: hcp.name,
      specialty: hcp.specialty,
      clinicKey: clinic.clinicKey,
      clinicLabel: clinic.label,
      zone: clinic.zone || hcp.zone,
      latitude: clinicGeo.latitude,
      longitude: clinicGeo.longitude,
      arrivalMinute: shiftStartMin,
      visitStartMinute: shiftStartMin,
      visitEndMinute: shiftStartMin + duration,
      visitDurationMinutes: duration,
      travelMinutesFromPrev: 0,
      distanceKmFromPrev: 0,
      executionStatus: 'PLANNED',
      isLocked: false,
    };

    const nextStops = [...existingStops, newStop];
    const variantCode = activePlan?.variantCode || 'A';
    const variantLabel = activePlan?.variantLabel || 'Balanced Priority';

    const recomputed = recomputePlanFromStops({
      userId: user.uid,
      dateIso: selectedDate,
      variantCode,
      variantLabel,
      isSelected: true,
      stops: nextStops,
      clinicsByKey,
      settings,
      targetVisits: targetOverride,
    });
    await saveDailyPlan(user.uid, recomputed);
    onToast(`Added ${hcp.name} (${clinic.label}).`);
  };

  const activeHcpsAll = useMemo(
    () => hcps.filter((h) => h.isActive && !h.isDeleted),
    [hcps]
  );

  const filteredAddDoctors = useMemo(() => {
    const q = addSearch.trim().toLowerCase();
    return activeHcpsAll
      .filter((h) => {
        if (addBrickFilter !== 'ALL') {
          const hClinics = clinicsByHcp.get(h.targetId) || [];
          const matchesBrick =
            h.zone?.trim() === addBrickFilter ||
            hClinics.some((c) => c.zone?.trim() === addBrickFilter);
          if (!matchesBrick) return false;
        }
        if (!q) return true;
        return (
          h.name.toLowerCase().includes(q) ||
          h.specialty.toLowerCase().includes(q) ||
          h.zone.toLowerCase().includes(q) ||
          h.targetId.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [activeHcpsAll, clinicsByHcp, addSearch, addBrickFilter]);

  const isoDay = getIsoDayOfWeek(selectedDate);
  const fullDayName = getIsoDayLabel(isoDay, 'full');

  return (
    <div className="space-y-3.5">
      {/* 1. 2-way Segmented Toggle: [ Daily Route ] | [ Weekly 5-Day ] */}
      <div className="grid grid-cols-2 h-[44px] rounded-full border border-[#CBD5E1] dark:border-[#475569] bg-white dark:bg-[#1E293B] overflow-hidden">
        <button
          type="button"
          onClick={() => setViewMode('daily')}
          className={`inline-flex items-center justify-center gap-2 text-sm font-semibold transition-colors ${
            viewMode === 'daily'
              ? 'bg-[#0F766E] dark:bg-[#115E59] text-white'
              : 'text-[#475569] dark:text-[#CBD5E1] hover:bg-[#F1F5F9] dark:hover:bg-[#334155]/40'
          }`}
        >
          {viewMode === 'daily' && <Check className="w-4 h-4" />}
          <span>Daily Route</span>
        </button>
        <button
          type="button"
          onClick={() => setViewMode('weekly')}
          className={`inline-flex items-center justify-center gap-2 text-sm font-semibold border-l border-[#CBD5E1] dark:border-[#475569] transition-colors ${
            viewMode === 'weekly'
              ? 'bg-[#0F766E] dark:bg-[#115E59] text-white'
              : 'text-[#475569] dark:text-[#CBD5E1] hover:bg-[#F1F5F9] dark:hover:bg-[#334155]/40'
          }`}
        >
          {viewMode === 'weekly' && <Check className="w-4 h-4" />}
          <span>Weekly 5-Day</span>
        </button>
      </div>

      {/* 2. Date Stepper Card (rounded-[20px]) */}
      <section className="rounded-[20px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] px-3.5 py-3.5 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setSelectedDate(addDaysIso(selectedDate, -1))}
          className="w-10 h-10 rounded-full bg-[#F1F5F9] dark:bg-[#334155] hover:bg-[#E2E8F0] dark:hover:bg-[#475569] inline-flex items-center justify-center text-[#0F172A] dark:text-[#F8FAFC] shrink-0"
          aria-label="Previous day"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <div className="flex-1 min-w-0 px-2">
          <div className="relative inline-flex items-center gap-1.5">
            <span className="text-[17px] font-bold tracking-tight text-[#0F172A] dark:text-[#F8FAFC] tabular-nums leading-snug">
              {fullDayName} • {selectedDate}
            </span>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
              aria-label="Pick date"
            />
          </div>
          <p className="mt-0.5 text-xs text-[#475569] dark:text-[#CBD5E1] tabular-nums">
            Hours: {formatMinuteOfDay(shiftStartMin)} – {formatMinuteOfDay(shiftEndMin)} • Goal:{' '}
            {targetOverride} Visits
          </p>
        </div>

        <button
          type="button"
          onClick={() => setSelectedDate(addDaysIso(selectedDate, 1))}
          className="w-10 h-10 rounded-full bg-[#F1F5F9] dark:bg-[#334155] hover:bg-[#E2E8F0] dark:hover:bg-[#475569] inline-flex items-center justify-center text-[#0F172A] dark:text-[#F8FAFC] shrink-0"
          aria-label="Next day"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </section>

      {/* 3. Planning Controls Card ("Work Timing & Bricks", rounded-[20px]) */}
      <section className="rounded-[20px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-3.5 space-y-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-10 h-10 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#60A5FA] inline-flex items-center justify-center shrink-0">
              <SlidersHorizontal className="w-[18px] h-[18px]" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-tight">
                Work Timing &amp; Bricks
              </h2>
              <p className="mt-0.5 text-xs text-[#475569] dark:text-[#CBD5E1] truncate tabular-nums">
                {formatMinuteOfDay(shiftStartMin)} – {formatMinuteOfDay(shiftEndMin)} •{' '}
                {targetOverride} Visits • {zoneFilter === 'ALL' ? 'All Bricks' : zoneFilter}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setControlsExpanded((v) => !v)}
            className="h-9 px-3.5 rounded-full bg-[#CCFBF1] dark:bg-[#115E59] text-[#0F766E] dark:text-[#CCFBF1] text-xs font-bold inline-flex items-center gap-1 shrink-0"
          >
            <span>{controlsExpanded ? 'Hide' : 'Edit'}</span>
            {controlsExpanded ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {controlsExpanded && (
          <div className="pt-3 border-t border-[#E2E8F0] dark:border-[#334155] space-y-3.5">
            {/* Target Visits */}
            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                Target Visits
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {[4, 6, 8, 10, 12].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setTargetOverride(n)}
                    className={`h-8 px-3 rounded-xl text-xs font-bold tabular-nums border transition-colors ${
                      targetOverride === n
                        ? 'bg-[#0F766E] dark:bg-[#115E59] text-white border-transparent'
                        : 'bg-[#F8FAFC] dark:bg-[#0F172A] text-[#0F172A] dark:text-[#CBD5E1] border-[#E2E8F0] dark:border-[#334155]'
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={targetOverride}
                  onChange={(e) =>
                    setTargetOverride(Math.max(1, Math.min(20, Number(e.target.value) || 8)))
                  }
                  className="w-16 h-8 px-2 rounded-xl border border-[#E2E8F0] dark:border-[#334155] bg-[#F8FAFC] dark:bg-[#0F172A] text-xs font-bold text-center tabular-nums"
                  aria-label="Custom daily target"
                />
              </div>
            </div>

            {/* Shift Presets + Custom From/To + Set */}
            <div className="space-y-2">
              <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                Shift Hours
              </span>
              <div className="flex flex-wrap gap-1.5">
                {SHIFT_PRESETS.map((p) => {
                  const active = shiftStartMin === p.start && shiftEndMin === p.end;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => applyShiftTimes(p.start, p.end)}
                      className={`h-8 px-3 rounded-xl text-xs font-semibold border transition-colors ${
                        active
                          ? 'bg-[#2563EB] text-white border-transparent'
                          : 'bg-[#F8FAFC] dark:bg-[#0F172A] text-[#0F172A] dark:text-[#CBD5E1] border-[#E2E8F0] dark:border-[#334155]'
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <label className="flex-1 block">
                  <span className="text-[11px] text-[#475569] dark:text-[#CBD5E1]">From</span>
                  <input
                    type="time"
                    value={customFromTime}
                    onChange={(e) => setCustomFromTime(e.target.value)}
                    className="mt-0.5 w-full h-9 px-2.5 rounded-xl border border-[#E2E8F0] dark:border-[#334155] bg-[#F8FAFC] dark:bg-[#0F172A] text-xs font-mono"
                  />
                </label>
                <label className="flex-1 block">
                  <span className="text-[11px] text-[#475569] dark:text-[#CBD5E1]">To</span>
                  <input
                    type="time"
                    value={customToTime}
                    onChange={(e) => setCustomToTime(e.target.value)}
                    className="mt-0.5 w-full h-9 px-2.5 rounded-xl border border-[#E2E8F0] dark:border-[#334155] bg-[#F8FAFC] dark:bg-[#0F172A] text-xs font-mono"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleSetCustomShift}
                  className="mt-4 h-9 px-4 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold"
                >
                  Set
                </button>
              </div>
            </div>

            {/* Brick / Zone Filter Chips */}
            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                Brick / Zone Filter
              </span>
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setZoneFilter('ALL')}
                  className={`h-8 px-3 rounded-full text-xs font-semibold border whitespace-nowrap ${
                    zoneFilter === 'ALL'
                      ? 'bg-[#0F766E] dark:bg-[#115E59] text-white border-transparent'
                      : 'bg-[#F8FAFC] dark:bg-[#0F172A] text-[#475569] dark:text-[#CBD5E1] border-[#E2E8F0] dark:border-[#334155]'
                  }`}
                >
                  All
                </button>
                {bricks.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setZoneFilter(b)}
                    className={`h-8 px-3 rounded-full text-xs font-semibold border whitespace-nowrap ${
                      zoneFilter === b
                        ? 'bg-[#0F766E] dark:bg-[#115E59] text-white border-transparent'
                        : 'bg-[#F8FAFC] dark:bg-[#0F172A] text-[#475569] dark:text-[#CBD5E1] border-[#E2E8F0] dark:border-[#334155]'
                    }`}
                    dir="auto"
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>

            {/* Starting Point / Live GPS / Brick Fallback */}
            <div className="pt-2.5 border-t border-[#E2E8F0] dark:border-[#334155] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[#475569] dark:text-[#CBD5E1]">
                  Starting Point (GPS / Brick)
                </span>
                <button
                  type="button"
                  disabled={locatingStart}
                  onClick={handleUseCurrentStartGps}
                  className="h-7 px-2.5 rounded-lg bg-[#0F766E]/15 hover:bg-[#0F766E]/25 disabled:opacity-50 text-[#0F766E] dark:text-[#2DD4BF] text-[11px] font-bold inline-flex items-center gap-1"
                >
                  <Crosshair className={`w-3 h-3 ${locatingStart ? 'animate-spin' : ''}`} />
                  <span>{locatingStart ? 'Locating...' : 'Use Current Location'}</span>
                </button>
              </div>

              {isValidLatLng(settings.homeLatitude, settings.homeLongitude) && (
                <p className="text-[11px] font-mono text-[#0F766E] dark:text-[#2DD4BF] tabular-nums">
                  Pinned: {settings.homeLatitude!.toFixed(4)}, {settings.homeLongitude!.toFixed(4)}
                  {settings.homeAddress ? ` • ${settings.homeAddress}` : ''}
                </p>
              )}

              {startGpsError && (
                <p className="text-[11px] text-[#D97706] dark:text-amber-400 leading-snug">
                  {startGpsError}
                </p>
              )}

              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  dir="auto"
                  value={startLocationInput}
                  onChange={(e) => setStartLocationInput(e.target.value)}
                  placeholder="Paste Google Maps URL or coordinates"
                  className="flex-1 h-9 px-2.5 rounded-xl border border-[#E2E8F0] dark:border-[#334155] bg-[#F8FAFC] dark:bg-[#0F172A] text-xs"
                />
                <button
                  type="button"
                  onClick={() => void handleApplyStartLocationInput()}
                  className="h-9 px-3 rounded-xl bg-[#2563EB] text-white text-xs font-bold shrink-0"
                >
                  Pin
                </button>
              </div>

              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) void handlePickStartZone(e.target.value);
                }}
                aria-label="Pick starting Brick or Zone"
                className="w-full h-9 px-2.5 rounded-xl border border-[#E2E8F0] dark:border-[#334155] bg-[#F8FAFC] dark:bg-[#0F172A] text-xs text-[#0F172A] dark:text-[#F8FAFC]"
              >
                <option value="">Or pick a starting Brick / Zone...</option>
                {EGYPT_ZONE_CENTROIDS.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </section>

      {viewMode === 'weekly' ? (
        /* 8. Weekly 5-Day Tab */
        <div className="space-y-3.5">
          <button
            type="button"
            disabled={busyLocal}
            onClick={() => void handleGenerateWeeklySchedule()}
            className="w-full h-[48px] rounded-[14px] bg-[#2563EB] dark:bg-[#60A5FA] hover:opacity-95 disabled:opacity-60 text-white dark:text-[#071633] text-sm font-bold inline-flex items-center justify-center gap-2 shadow-xs"
          >
            <Sparkles className="w-4 h-4" />
            <span>{busyLocal ? 'Generating Weekly Schedule...' : 'Generate Weekly Schedule'}</span>
          </button>

          <div className="space-y-3">
            {workingWeekDates.map((d) => {
              const dayPlan =
                plans.find((p) => p.dateIso === d.dateIso && p.isSelected) ||
                plans.find((p) => p.dateIso === d.dateIso && p.variantCode === 'A');

              return (
                <section
                  key={d.dateIso}
                  className="rounded-[20px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-bold text-[#0F172A] dark:text-[#F8FAFC]">
                        {formatReadableDate(d.dateIso)}
                      </h3>
                      <p className="text-xs text-[#475569] dark:text-[#CBD5E1] tabular-nums">
                        {dayPlan && dayPlan.stops.length > 0
                          ? `${dayPlan.plannedVisitsCount}/${targetOverride} visits • ${dayPlan.totalDistanceKm.toFixed(1)} km • ${dayPlan.totalDrivingMinutes}m drive`
                          : 'No stops planned yet'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedDate(d.dateIso);
                        setViewMode('daily');
                      }}
                      className="h-8 px-3 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#60A5FA] text-xs font-bold"
                    >
                      Open Day
                    </button>
                  </div>

                  {dayPlan && dayPlan.stops.length > 0 && (
                    <div className="divide-y divide-[#E2E8F0] dark:divide-[#334155] pt-1">
                      {dayPlan.stops.map((s) => (
                        <div
                          key={s.clinicKey}
                          className="py-1.5 flex items-center justify-between gap-2 text-xs"
                        >
                          <span
                            className="font-medium text-[#0F172A] dark:text-[#F8FAFC] truncate"
                            dir="auto"
                          >
                            {s.stopOrder}. {s.hcpName}
                          </span>
                          <span className="font-mono text-[#475569] dark:text-[#CBD5E1] shrink-0 tabular-nums">
                            {formatMinuteOfDay(s.visitStartMinute)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        /* Daily Route Mode */
        <div className="space-y-3.5">
          {/* 4. Primary Action Row (2 buttons side-by-side) */}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={busyLocal}
              onClick={() => void handleAiRoutePlan()}
              className="flex-[1.15] h-[48px] rounded-[14px] bg-[#2563EB] dark:bg-[#60A5FA] hover:opacity-95 disabled:opacity-60 text-white dark:text-[#071633] text-sm font-bold inline-flex items-center justify-center gap-2 shadow-xs"
            >
              <Sparkles className="w-4 h-4" />
              <span>AI Route Plan</span>
            </button>

            <button
              type="button"
              onClick={() => setShowAddHcpModal(true)}
              className="flex-1 h-[48px] rounded-[14px] bg-[#DBEAFE] dark:bg-[#115E59] hover:opacity-95 text-[#2563EB] dark:text-[#CCFBF1] text-sm font-bold inline-flex items-center justify-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Add HCP</span>
            </button>
          </div>

          {/* 5. Alternative Plans Comparison Card ("Route Options (3)", rounded-[22px]) */}
          {plansForSelectedDate.length > 0 && activePlan && (
            <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="w-9 h-9 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#60A5FA] inline-flex items-center justify-center shrink-0">
                    <ArrowLeftRight className="w-4 h-4" />
                  </span>
                  <h2 className="text-[15px] font-bold text-[#0F172A] dark:text-[#F8FAFC] truncate">
                    Route Options ({plansForSelectedDate.length})
                  </h2>
                </div>

                <button
                  type="button"
                  onClick={() => setShowComparePlans((v) => !v)}
                  className="px-3.5 py-1.5 rounded-xl border border-[#CBD5E1] dark:border-[#475569] text-xs font-semibold text-[#0F172A] dark:text-[#F8FAFC] hover:bg-[#F1F5F9] dark:hover:bg-[#334155]"
                >
                  Compare A/B/C
                </button>
              </div>

              {/* Active Plan Dropdown Selector */}
              <select
                value={activePlan.variantCode}
                onChange={(e) => void handleSelectVariant(e.target.value)}
                className="w-full h-11 px-3.5 rounded-full border border-[#CBD5E1] dark:border-[#475569] bg-[#F8FAFC] dark:bg-[#0F172A] text-xs sm:text-sm font-semibold text-[#0F172A] dark:text-[#F8FAFC]"
                aria-label="Select route variant"
              >
                {plansForSelectedDate.map((p) => (
                  <option key={p.id} value={p.variantCode}>
                    Plan {p.variantCode}: {p.variantLabel} ({p.plannedVisitsCount} visits •{' '}
                    {p.totalDistanceKm.toFixed(1)} km)
                  </option>
                ))}
              </select>

              {/* Expandable A/B/C Comparison Grid */}
              {showComparePlans && (
                <div className="grid grid-cols-1 gap-2 pt-1">
                  {plansForSelectedDate.map((p) => {
                    const selected = p.variantCode === activePlan.variantCode;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => void handleSelectVariant(p.variantCode)}
                        className={`w-full text-left rounded-[16px] p-3 border transition-colors ${
                          selected
                            ? 'bg-[#DBEAFE]/60 dark:bg-[#1E3A8A]/55 border-[#2563EB] dark:border-[#60A5FA]'
                            : 'bg-[#F8FAFC] dark:bg-[#0F172A]/60 border-[#E2E8F0] dark:border-[#334155]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-[#0F172A] dark:text-[#F8FAFC]">
                            Plan {p.variantCode} • {p.variantLabel}
                          </span>
                          <span
                            className={`text-[11px] font-bold ${
                              p.feasibilityStatus === 'FEASIBLE'
                                ? 'text-[#0F766E] dark:text-[#2DD4BF]'
                                : p.feasibilityStatus === 'PARTIAL_TARGET'
                                  ? 'text-[#D97706] dark:text-amber-400'
                                  : 'text-[#DC2626] dark:text-red-400'
                            }`}
                          >
                            {p.feasibilityStatus.replace('_', ' ')}
                          </span>
                        </div>
                        <div className="mt-1.5 grid grid-cols-4 gap-2 text-[11px] tabular-nums text-[#475569] dark:text-[#CBD5E1]">
                          <span>
                            <strong className="text-[#0F172A] dark:text-[#F8FAFC]">{p.plannedVisitsCount}</strong> visits
                          </span>
                          <span>
                            <strong className="text-[#0F172A] dark:text-[#F8FAFC]">{p.totalDrivingMinutes}m</strong> drive
                          </span>
                          <span>
                            <strong className="text-[#0F172A] dark:text-[#F8FAFC]">{p.totalDistanceKm.toFixed(1)}</strong> km
                          </span>
                          <span>
                            <strong className="text-[#0F172A] dark:text-[#F8FAFC]">{formatDuration(p.totalDutySpanMinutes)}</strong> span
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* 6. Active Route Summary Card (rounded-[22px]) */}
          {activePlan ? (
            <>
              <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-3.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-[16px] font-bold text-[#0F172A] dark:text-[#F8FAFC]">
                    Active Route Summary
                  </h2>
                  <span
                    title={`Quarterly Coverage: ${remainingByHcp.totalCompleted}/${remainingByHcp.totalTarget} visits (${remainingByHcp.coveragePct}%)`}
                    className="rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#60A5FA] px-3 py-1 text-xs font-bold tabular-nums"
                  >
                    {remainingByHcp.totalRem} Rem. Qtr • {remainingByHcp.coveragePct}%
                  </span>
                </div>

                <div className="flex items-center justify-between gap-2 text-xs text-[#475569] dark:text-[#CBD5E1] tabular-nums">
                  <span>
                    Shift Window:{' '}
                    {activePlan.stops.length > 0
                      ? `${formatMinuteOfDay(activePlan.startMinuteOfDay)} – ${formatMinuteOfDay(activePlan.endMinuteOfDay)}`
                      : 'No stops scheduled'}
                  </span>
                  {fullRouteUrl && (
                    <a
                      href={fullRouteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#2563EB] dark:text-[#60A5FA] font-bold hover:underline inline-flex items-center gap-1"
                    >
                      <Navigation className="w-3 h-3" />
                      <span>Full Route</span>
                    </a>
                  )}
                </div>

                {/* 4 Tinted Metric Tiles */}
                <div className="grid grid-cols-4 gap-2 text-center tabular-nums">
                  <div className="rounded-[14px] bg-[#0F766E]/12 dark:bg-[#115E59]/50 p-2.5">
                    <p className="text-[15px] font-extrabold text-[#0F766E] dark:text-[#2DD4BF]">
                      {activePlan.plannedVisitsCount}/{targetOverride}
                    </p>
                    <p className="mt-0.5 text-[11px] font-medium text-[#0F766E]/90 dark:text-[#2DD4BF]/90">
                      Visits
                    </p>
                  </div>
                  <div className="rounded-[14px] bg-[#2563EB]/12 dark:bg-[#1E3A8A]/70 p-2.5">
                    <p className="text-[15px] font-extrabold text-[#2563EB] dark:text-[#60A5FA]">
                      {activePlan.totalDistanceKm.toFixed(1)} km
                    </p>
                    <p className="mt-0.5 text-[11px] font-medium text-[#2563EB]/90 dark:text-[#93C5FD]">
                      Distance
                    </p>
                  </div>
                  <div className="rounded-[14px] bg-[#0F766E]/12 dark:bg-[#115E59]/50 p-2.5">
                    <p className="text-[15px] font-extrabold text-[#0F766E] dark:text-[#2DD4BF]">
                      {activePlan.totalDrivingMinutes}m
                    </p>
                    <p className="mt-0.5 text-[11px] font-medium text-[#0F766E]/90 dark:text-[#2DD4BF]/90">
                      Drive
                    </p>
                  </div>
                  <div className="rounded-[14px] bg-[#F1F5F9] dark:bg-[#334155]/70 p-2.5">
                    <p className="text-[15px] font-extrabold text-[#0F766E] dark:text-[#2DD4BF]">
                      {activePlan.totalWaitingMinutes}m
                    </p>
                    <p className="mt-0.5 text-[11px] font-medium text-[#475569] dark:text-[#CBD5E1]">
                      Gap Wait
                    </p>
                  </div>
                </div>

                {/* Inner Plan Generation Summary Box */}
                <div className="rounded-[16px] bg-[#F8FAFC] dark:bg-[#0F172A]/75 border border-[#E2E8F0] dark:border-[#334155] p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-[#0F172A] dark:text-[#F8FAFC]">
                      Plan Generation Summary
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                        activePlan.feasibilityStatus === 'FEASIBLE'
                          ? 'bg-[#0F766E]/15 text-[#0F766E] dark:text-[#2DD4BF]'
                          : activePlan.feasibilityStatus === 'PARTIAL_TARGET'
                            ? 'bg-[#D97706]/15 text-[#D97706] dark:text-amber-400'
                            : 'bg-[#DC2626]/15 text-[#DC2626] dark:text-red-400'
                      }`}
                    >
                      {activePlan.feasibilityStatus === 'FEASIBLE'
                        ? 'Feasible'
                        : activePlan.feasibilityStatus === 'PARTIAL_TARGET'
                          ? 'Partial Target'
                          : 'Infeasible'}
                    </span>
                  </div>
                  <p className="text-xs text-[#475569] dark:text-[#CBD5E1] tabular-nums leading-relaxed">
                    Eligible considered: {selectedDayStats.eligible} • Weekly excluded:{' '}
                    {selectedDayStats.weeklyExcluded} • Schedule/availability excluded:{' '}
                    {selectedDayStats.scheduleExcluded}
                  </p>
                  {activePlan.stops.length > 0 && (
                    <button
                      type="button"
                      disabled={busyLocal}
                      onClick={() => void handleCommitPlanLocks()}
                      className="w-full h-9 rounded-xl bg-[#0F766E]/15 hover:bg-[#0F766E]/25 text-[#0F766E] dark:text-[#2DD4BF] text-xs font-bold inline-flex items-center justify-center gap-1.5"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      <span>Commit All Stops to Visits &amp; Weekly Locks</span>
                    </button>
                  )}
                </div>
              </section>

              {/* Depart At Bar */}
              {activePlan.stops.length > 0 && (
                <div className="rounded-[14px] bg-[#DBEAFE] dark:bg-[#1E3A8A]/75 px-4 py-2.5 text-sm font-bold text-[#0B2559] dark:text-[#E0ECFF] flex items-center gap-2.5 tabular-nums">
                  <Home className="w-4 h-4 text-[#2563EB] dark:text-[#60A5FA]" />
                  <span>Depart at {formatMinuteOfDay(activePlan.startMinuteOfDay)}</span>
                </div>
              )}

              {/* 7. Ordered Planned Stop Timeline Cards */}
              {activePlan.stops.length === 0 ? (
                <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-6 text-center space-y-2">
                  <p className="text-sm font-bold text-[#0F172A] dark:text-[#F8FAFC]">
                    No stops scheduled for {formatReadableDate(selectedDate)}
                  </p>
                  <p className="text-xs text-[#475569] dark:text-[#CBD5E1]">
                    {activePlan.infeasibilityReasonsText ||
                      'Tap AI Route Plan or + Add HCP to schedule clinics open on this day.'}
                  </p>
                </section>
              ) : (
                <div className="space-y-3.5">
                  {activePlan.stops.map((stop, idx) => {
                    const clinic = clinicsByKey.get(stop.clinicKey);
                    const hcpClinics = clinicsByHcp.get(stop.hcpTargetId) || [];
                    const liveVisit = visitByHcpDate.get(`${stop.hcpTargetId}__${activePlan.dateIso}`);
                    const effectiveStatus: VisitStatus =
                      liveVisit?.status || stop.executionStatus || 'PLANNED';
                    const clinicGeo = clinic ? getEffectiveClinicCoordinates(clinic) : null;
                    const effLat = isValidLatLng(stop.latitude, stop.longitude)
                      ? stop.latitude
                      : clinicGeo?.latitude ?? null;
                    const effLng = isValidLatLng(stop.latitude, stop.longitude)
                      ? stop.longitude
                      : clinicGeo?.longitude ?? null;
                    const mapsUrl = buildGoogleMapsDirectionsUrl(
                      effLat,
                      effLng,
                      clinicGeo?.googleMapsUrl || clinic?.googleMapsUrl,
                      `${stop.hcpName} ${stop.zone}`
                    );
                    const isSameBuilding =
                      idx > 0 && stop.travelMinutesFromPrev === 0 && stop.distanceKmFromPrev === 0;
                    const remLeft = remainingByHcp.map.get(stop.hcpTargetId) ?? 0;

                    // Clinic window string on this day
                    const dayWin = clinic
                      ? getEffectiveClinicWindows(clinic).windows.find((w) => w.dayOfWeek === isoDay)
                      : undefined;
                    const clinicWindowLabel = dayWin
                      ? `${formatMinuteOfDay(dayWin.startMinuteOfDay)} – ${formatMinuteOfDay(dayWin.endMinuteOfDay)}`
                      : 'Manual Window';

                    const departMinute = Math.max(0, stop.arrivalMinute - stop.travelMinutesFromPrev);

                    return (
                      <section
                        key={`${stop.clinicKey}_${idx}`}
                        className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-3.5"
                      >
                        {/* Top Travel Strip */}
                        <div className="rounded-xl bg-[#F1F5F9] dark:bg-[#334155]/75 px-3 py-2 text-xs font-semibold text-[#475569] dark:text-[#CBD5E1] flex items-center gap-2 tabular-nums">
                          {isSameBuilding ? (
                            <>
                              <Building2 className="w-3.5 h-3.5 text-[#0F766E] dark:text-[#2DD4BF] shrink-0" />
                              <span className="text-[#0F766E] dark:text-[#2DD4BF]">
                                Same building • Sequential visit (0m drive)
                              </span>
                            </>
                          ) : (
                            <>
                              <Car className="w-3.5 h-3.5 text-[#2563EB] dark:text-[#60A5FA] shrink-0" />
                              <span>
                                Depart {formatMinuteOfDay(departMinute)} • Drive{' '}
                                {stop.travelMinutesFromPrev}m ({stop.distanceKmFromPrev.toFixed(1)} km)
                              </span>
                            </>
                          )}
                        </div>

                        {/* Doctor Header Row */}
                        <div className="flex items-start gap-3">
                          <span
                            className={`w-10 h-10 rounded-full text-sm font-extrabold tabular-nums inline-flex items-center justify-center shrink-0 ${
                              effectiveStatus === 'COMPLETED'
                                ? 'bg-[#0F766E] text-white'
                                : effectiveStatus === 'CANCELLED'
                                  ? 'bg-[#DC2626] text-white'
                                  : effectiveStatus === 'NOT_COMPLETED'
                                    ? 'bg-[#D97706] text-white'
                                    : 'bg-[#38BDF8] dark:bg-[#2DD4BF] text-[#071633]'
                            }`}
                          >
                            {effectiveStatus === 'COMPLETED' ? (
                              <Check className="w-5 h-5" />
                            ) : (
                              stop.stopOrder
                            )}
                          </span>

                          <div className="min-w-0 flex-1">
                            <h3
                              className={`text-base font-bold leading-snug ${
                                effectiveStatus === 'CANCELLED'
                                  ? 'line-through text-[#475569] dark:text-[#CBD5E1]'
                                  : 'text-[#0F172A] dark:text-[#F8FAFC]'
                              }`}
                              dir="auto"
                            >
                              {stop.hcpName}
                            </h3>
                            <p
                              className="mt-0.5 text-xs font-medium text-[#2563EB] dark:text-[#60A5FA] leading-relaxed"
                              dir="auto"
                            >
                              {stop.specialty || 'General'} • {stop.clinicLabel}
                              {stop.zone ? ` • ${stop.zone}` : ''}
                            </p>

                            {hcpClinics.length > 1 && (
                              <select
                                value={stop.clinicKey}
                                onChange={(e) => void handleSwitchStopClinic(idx, e.target.value)}
                                className="mt-1.5 h-8 px-2.5 rounded-lg border border-[#E2E8F0] dark:border-[#334155] bg-[#F8FAFC] dark:bg-[#0F172A] text-xs font-semibold text-[#0F172A] dark:text-[#F8FAFC]"
                              >
                                {hcpClinics.map((c) => (
                                  <option key={c.clinicKey} value={c.clinicKey}>
                                    Switch to {c.label} {c.zone ? `(${c.zone})` : ''}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </div>

                        {/* Tinted Blue Inner Schedule & Priority Box */}
                        <div className="rounded-[16px] bg-[#DBEAFE]/50 dark:bg-[#1E3A8A]/45 border border-[#2563EB]/25 dark:border-[#60A5FA]/30 p-3 space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="inline-flex items-center gap-1.5 font-bold text-[#2563EB] dark:text-[#93C5FD] tabular-nums">
                              <Clock className="w-3.5 h-3.5 shrink-0" />
                              <span>
                                Visit: {formatMinuteOfDay(stop.visitStartMinute)} –{' '}
                                {formatMinuteOfDay(stop.visitEndMinute)}
                              </span>
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setEditingDurationStopIdx(editingDurationStopIdx === idx ? null : idx)
                              }
                              className="inline-flex items-center gap-1 rounded-full bg-[#2563EB]/15 dark:bg-[#2563EB]/40 text-[#2563EB] dark:text-[#DBEAFE] px-2.5 py-0.5 text-[11px] font-bold tabular-nums"
                            >
                              <span>{stop.visitDurationMinutes}m</span>
                              <Pencil className="w-2.5 h-2.5" />
                            </button>
                          </div>

                          {/* Duration Chips (15m / 20m / 30m) */}
                          {editingDurationStopIdx === idx && (
                            <div className="flex items-center gap-1.5 pt-0.5">
                              {DURATION_CHIPS.map((m) => (
                                <button
                                  key={m}
                                  type="button"
                                  onClick={() => void handleChangeStopDuration(idx, m)}
                                  className={`h-7 px-3 rounded-full text-[11px] font-bold tabular-nums ${
                                    stop.visitDurationMinutes === m
                                      ? 'bg-[#2563EB] text-white'
                                      : 'bg-white dark:bg-[#0F172A] text-[#0F172A] dark:text-[#F8FAFC] border border-[#CBD5E1] dark:border-[#475569]'
                                  }`}
                                >
                                  {m}m
                                </button>
                              ))}
                            </div>
                          )}

                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="inline-flex items-center gap-1.5 text-[#0F172A] dark:text-[#E2E8F0] tabular-nums">
                              <Store className="w-3.5 h-3.5 text-[#475569] dark:text-[#93C5FD] shrink-0" />
                              <span>Clinic Window: {clinicWindowLabel}</span>
                            </span>
                            <span className="rounded-full bg-[#2563EB]/15 dark:bg-[#2563EB]/40 text-[#2563EB] dark:text-[#DBEAFE] px-2.5 py-0.5 text-[11px] font-bold tabular-nums shrink-0">
                              {remLeft} visits left
                            </span>
                          </div>

                          <p className="text-[11px] text-[#475569] dark:text-[#CBD5E1] leading-relaxed">
                            Prioritized for {remLeft} remaining quarterly visit(s) and valid{' '}
                            {stop.specialty || 'clinic'} availability window.
                          </p>
                        </div>

                        {/* Action Row 1: Up, Down, Lock, Complete */}
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => void handleMoveStop(idx, -1)}
                            className="w-11 h-11 rounded-[12px] bg-[#F1F5F9] dark:bg-[#334155]/70 hover:bg-[#E2E8F0] dark:hover:bg-[#334155] disabled:opacity-35 inline-flex items-center justify-center text-[#0F172A] dark:text-[#F8FAFC]"
                            aria-label="Move stop up"
                          >
                            <ArrowUp className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === activePlan.stops.length - 1}
                            onClick={() => void handleMoveStop(idx, 1)}
                            className="w-11 h-11 rounded-[12px] bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 hover:opacity-90 disabled:opacity-35 inline-flex items-center justify-center text-[#2563EB] dark:text-[#93C5FD]"
                            aria-label="Move stop down"
                          >
                            <ArrowDown className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleToggleLockStop(idx)}
                            className={`w-11 h-11 rounded-[12px] border inline-flex items-center justify-center transition-colors ${
                              stop.isLocked
                                ? 'bg-[#0F766E]/15 border-[#0F766E]/40 text-[#0F766E] dark:text-[#2DD4BF]'
                                : 'bg-[#F1F5F9] dark:bg-[#334155]/70 border-transparent text-[#475569] dark:text-[#CBD5E1]'
                            }`}
                            aria-label="Toggle stop lock"
                            title={stop.isLocked ? 'Locked' : 'Unlocked'}
                          >
                            {stop.isLocked ? (
                              <Lock className="w-4 h-4" />
                            ) : (
                              <Unlock className="w-4 h-4" />
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleStopStatusChange(idx, 'COMPLETED')}
                            className={`flex-1 h-11 rounded-[12px] font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors ${
                              effectiveStatus === 'COMPLETED'
                                ? 'bg-[#0F766E] text-white ring-2 ring-[#2DD4BF]/50'
                                : 'bg-[#0F766E] hover:bg-[#0D655E] text-white'
                            }`}
                          >
                            <Check className="w-4 h-4" />
                            <span>{effectiveStatus === 'COMPLETED' ? 'Completed' : 'Complete'}</span>
                          </button>
                        </div>

                        {/* Action Row 2: Cancel (Crimson), Missed (Amber), Maps (Blue) */}
                        <div className="grid grid-cols-3 gap-2">
                          <button
                            type="button"
                            onClick={() => void handleStopStatusChange(idx, 'CANCELLED')}
                            className={`h-11 rounded-[12px] font-bold text-xs inline-flex items-center justify-center gap-1.5 transition-colors ${
                              effectiveStatus === 'CANCELLED'
                                ? 'bg-[#DC2626] text-white ring-2 ring-red-400/50'
                                : 'bg-[#DC2626] hover:bg-[#B91C1C] text-white'
                            }`}
                          >
                            <XCircle className="w-4 h-4 shrink-0" />
                            <span>Cancel</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleStopStatusChange(idx, 'NOT_COMPLETED')}
                            className={`h-11 rounded-[12px] font-bold text-xs inline-flex items-center justify-center gap-1.5 transition-colors ${
                              effectiveStatus === 'NOT_COMPLETED'
                                ? 'bg-[#D97706] text-white ring-2 ring-amber-300/50'
                                : 'bg-[#D97706] hover:bg-[#B45309] text-white'
                            }`}
                          >
                            <CalendarX2 className="w-4 h-4 shrink-0" />
                            <span>Missed</span>
                          </button>

                          {mapsUrl ? (
                            <a
                              href={mapsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="h-11 rounded-[12px] bg-[#DBEAFE]/70 dark:bg-[#1E3A8A]/70 border border-[#2563EB]/40 dark:border-[#60A5FA]/50 hover:opacity-90 text-[#2563EB] dark:text-[#93C5FD] font-bold text-xs inline-flex items-center justify-center gap-1.5"
                            >
                              <Navigation className="w-3.5 h-3.5 shrink-0" />
                              <span>Maps</span>
                            </a>
                          ) : (
                            <button
                              type="button"
                              disabled
                              className="h-11 rounded-[12px] bg-[#F1F5F9] dark:bg-[#334155]/40 text-[#94A3B8] font-bold text-xs inline-flex items-center justify-center gap-1.5 opacity-60"
                            >
                              <Navigation className="w-3.5 h-3.5 shrink-0" />
                              <span>No GPS</span>
                            </button>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            /* Empty state before first optimization */
            <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-7 text-center space-y-2.5">
              <div className="w-12 h-12 rounded-2xl bg-[#DBEAFE] dark:bg-[#1E3A8A] text-[#2563EB] dark:text-[#60A5FA] flex items-center justify-center mx-auto">
                <Calendar className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-[#0F172A] dark:text-[#F8FAFC]">
                No Route Planned for {formatReadableDate(selectedDate)}
              </h3>
              <p className="text-xs text-[#475569] dark:text-[#CBD5E1] max-w-xs mx-auto">
                Tap <strong>AI Route Plan</strong> above to generate optimized Plans A, B, and C, or tap{' '}
                <strong>+ Add HCP</strong> to build your route manually.
              </p>
            </section>
          )}
        </div>
      )}

      {/* 7. "Add HCP" Modal */}
      {showAddHcpModal && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Add HCP to Route"
        >
          <div className="w-full max-w-[520px] max-h-[88vh] flex flex-col rounded-t-[26px] sm:rounded-[26px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[#E2E8F0] dark:border-[#334155] flex items-center justify-between">
              <h3 className="text-base font-bold text-[#0F172A] dark:text-[#F8FAFC]">
                Add HCP • {selectedDate}
              </h3>
              <button
                type="button"
                onClick={() => setShowAddHcpModal(false)}
                className="p-1.5 text-[#475569] dark:text-[#CBD5E1]"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 border-b border-[#E2E8F0] dark:border-[#334155] space-y-3">
              <div className="relative">
                <Search className="w-4 h-4 text-[#475569] dark:text-[#CBD5E1] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={addSearch}
                  onChange={(e) => setAddSearch(e.target.value)}
                  placeholder="Search Doctor, Specialty, Brick..."
                  dir="auto"
                  className="w-full h-11 pl-10 pr-3.5 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] bg-[#F8FAFC] dark:bg-[#0F172A] text-sm text-[#0F172A] dark:text-[#F8FAFC]"
                />
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                <button
                  type="button"
                  onClick={() => setAddBrickFilter('ALL')}
                  className={`h-8 px-3 rounded-full text-xs font-semibold border whitespace-nowrap ${
                    addBrickFilter === 'ALL'
                      ? 'bg-[#0F766E] dark:bg-[#115E59] text-white border-transparent'
                      : 'border-[#CBD5E1] dark:border-[#475569] text-[#475569] dark:text-[#CBD5E1]'
                  }`}
                >
                  All ({activeHcpsAll.length})
                </button>
                {bricks.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setAddBrickFilter(b)}
                    className={`h-8 px-3 rounded-full text-xs font-semibold border whitespace-nowrap ${
                      addBrickFilter === b
                        ? 'bg-[#0F766E] dark:bg-[#115E59] text-white border-transparent'
                        : 'border-[#CBD5E1] dark:border-[#475569] text-[#475569] dark:text-[#CBD5E1]'
                    }`}
                    dir="auto"
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-[#E2E8F0] dark:divide-[#334155]">
              {filteredAddDoctors.length === 0 ? (
                <p className="p-6 text-center text-sm text-[#475569] dark:text-[#CBD5E1]">
                  No matching doctors found.
                </p>
              ) : (
                filteredAddDoctors.slice(0, 60).map((hcp) => {
                  const hClinics = clinicsByHcp.get(hcp.targetId) || [];
                  const lock = weekLocksForWeek.get(hcp.targetId);
                  const visitedThisWeek = Boolean(lock);

                  return (
                    <div key={hcp.id} className="p-4 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p
                            className="text-sm font-bold text-[#0F172A] dark:text-[#F8FAFC] truncate"
                            dir="auto"
                          >
                            {hcp.name}
                          </p>
                          <p className="text-xs text-[#475569] dark:text-[#CBD5E1]">
                            {hcp.specialty} {hcp.zone ? `• ${hcp.zone}` : ''}
                          </p>
                        </div>
                        {visitedThisWeek && (
                          <span className="rounded-full bg-[#D97706]/15 text-[#D97706] dark:text-amber-400 px-2.5 py-0.5 text-[11px] font-bold shrink-0">
                            This Week
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {hClinics.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            disabled={
                              settings.enforceWeeklyHcpVisitLimit !== false &&
                              Boolean(lock && lock.plannedDateIso !== selectedDate)
                            }
                            onClick={() => void handleManualAddStop(hcp.targetId, c)}
                            className="h-9 px-3.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-40 text-white text-xs font-bold inline-flex items-center gap-1.5"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>
                              Add ({c.label}
                              {c.zone ? ` • ${c.zone}` : ''})
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="p-4 border-t border-[#E2E8F0] dark:border-[#334155]">
              <button
                type="button"
                onClick={() => setShowAddHcpModal(false)}
                className="w-full h-11 rounded-[14px] bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-bold"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
