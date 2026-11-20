import {
  Clinic,
  ClinicWindow,
  DailyPlan,
  FeasibilityStatus,
  Hcp,
  PlanStop,
  Visit,
  WeeklyLock,
  WorkSettings,
} from '../types/territory';
import {
  daysBetweenIso,
  formatMinuteOfDay,
  getIsoDayOfWeek,
  getWeekBounds,
  getWeekDates,
} from './dateUtils';
import { estimateTravel, isValidCoordinatePair } from './geoUtils';
import { planDocId } from './firestoreService';
import { getEffectiveClinicWindows } from '../utils/availabilityScheduleParser';
import { getEffectiveClinicCoordinates } from '../utils/gpsLocationParser';

export const EXHAUSTED_COMBINATIONS_NOTE =
  'All feasible HCP combinations for this date were shown; showing best valid order.';

export interface CandidateClinicSlot {
  hcp: Hcp;
  clinic: Clinic;
  window: ClinicWindow;
  windowStart: number;
  windowEnd: number; // may exceed 1440 if endsNextDay
  remainingVisits: number;
  completedThisQuarter: number;
  daysSinceLastVisit: number;
  visitDuration: number;
  priorityWeight: number;
  isLockedFixed?: boolean;
  preferredStartMinute?: number;
  fixedExecutionStatus?: PlanStop['executionStatus'];
}

export interface OptimizeDayInput {
  userId: string;
  dateIso: string;
  hcps: Hcp[];
  clinics: Clinic[];
  visits: Visit[];
  weeklyLocks: WeeklyLock[];
  settings: WorkSettings;
  zoneFilter?: string;
  targetOverride?: number;
  shiftStartMinute?: number;
  shiftEndMinute?: number;
  sameClinicGapMinutes?: number;
  extraBlockedHcpIds?: Set<string>;
  diversitySeed?: number;
  previousPlanStopKeys?: string[];
  lockedStops?: PlanStop[];
  existingWeekPlans?: DailyPlan[];
}

export function getStopKey(stop: Pick<PlanStop, 'hcpTargetId' | 'clinicKey'>): string {
  return `${stop.hcpTargetId}:${stop.clinicKey}`;
}

export function getRouteSignature(stops: Array<Pick<PlanStop, 'hcpTargetId' | 'clinicKey'>>): string {
  return stops.map((s) => `${s.hcpTargetId}:${s.clinicKey}`).join('>');
}

export function getRouteHcpSetSignature(
  stops: Array<Pick<PlanStop, 'hcpTargetId' | 'clinicKey'>>
): string {
  return stops
    .map((s) => `${s.hcpTargetId}:${s.clinicKey}`)
    .sort()
    .join('|');
}

export function hashStopSeed(hcpId: string, clinicId: string, seed: number): number {
  const input = `${hcpId}|${clinicId}|${seed}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function computeHcpQuarterCoverage(
  hcp: Hcp,
  visits: Visit[],
  currentQuarterLabel: string,
  referenceDateIso: string
): { completed: number; remaining: number; daysSinceLastVisit: number } {
  const baseline =
    !hcp.baselineQuarterLabel || hcp.baselineQuarterLabel === currentQuarterLabel
      ? hcp.importedBaselineVisits || 0
      : 0;

  const qualifying = visits.filter(
    (v) =>
      v.hcpTargetId === hcp.targetId &&
      v.status === 'COMPLETED' &&
      v.qualifiesForCoverage !== false &&
      (!v.quarterLabel || v.quarterLabel === currentQuarterLabel)
  );

  const completed = baseline + qualifying.length;
  const target = Math.max(1, hcp.quarterlyTarget || 8);
  const remaining = Math.max(0, target - completed);

  let daysSinceLastVisit = 45;
  const allCompleted = visits
    .filter((v) => v.hcpTargetId === hcp.targetId && v.status === 'COMPLETED')
    .map((v) => v.plannedDateIso)
    .sort();
  if (allCompleted.length > 0) {
    const last = allCompleted[allCompleted.length - 1];
    daysSinceLastVisit = Math.max(0, daysBetweenIso(last, referenceDateIso));
  }

  return { completed, remaining, daysSinceLastVisit };
}

function getEffectiveWindowBounds(w: ClinicWindow): { start: number; end: number } {
  const start = Math.max(0, Math.min(1439, w.startMinuteOfDay));
  let end = Math.max(0, Math.min(1439, w.endMinuteOfDay));
  if (w.endsNextDay || end <= start) {
    end += 1440;
  }
  return { start, end };
}

function getSpecialtyRankBonus(specialty: string, settings: WorkSettings): number {
  const ranked = settings.preferredSpecialtiesRanked || [];
  if (!settings.hasUserConfiguredPreferredSpecialties || ranked.length === 0) return 0.5;
  const idx = ranked.findIndex((s) => s.toLowerCase() === (specialty || '').toLowerCase());
  if (idx === -1) return 0.2;
  return 1 - idx / Math.max(1, ranked.length);
}

/**
 * Recomputes arrival, visit start/end, travel legs, duty span, and validator report
 * for any ordered list of stops (used after optimization AND after manual edits).
 */
export function recomputePlanFromStops(params: {
  userId: string;
  dateIso: string;
  variantCode: string;
  variantLabel: string;
  isSelected: boolean;
  stops: PlanStop[];
  clinicsByKey: Map<string, Clinic>;
  settings: WorkSettings;
  targetVisits: number;
  eligibleUniqueHcpsCount?: number;
  weeklyLockedCount?: number;
  weekendBlocked?: boolean;
  shiftStartMinute?: number;
  shiftEndMinute?: number;
  exhaustionNote?: string;
}): DailyPlan {
  const {
    userId,
    dateIso,
    variantCode,
    variantLabel,
    isSelected,
    stops,
    clinicsByKey,
    settings,
    targetVisits,
    eligibleUniqueHcpsCount,
    weeklyLockedCount,
    weekendBlocked,
    shiftStartMinute,
    shiftEndMinute,
    exhaustionNote,
  } = params;

  const isoDay = getIsoDayOfWeek(dateIso);
  const maxDuty = Math.max(60, settings.maxDutySpanMinutes || 480);
  const hasHome = isValidCoordinatePair(settings.homeLatitude, settings.homeLongitude);
  const hasShiftBounds =
    typeof shiftStartMinute === 'number' &&
    typeof shiftEndMinute === 'number' &&
    shiftEndMinute > shiftStartMinute;

  const reasons: string[] = [];
  const reportLines: string[] = [];

  if (weekendBlocked) {
    reasons.push('Selected date is configured as a weekend day in Work Settings.');
  }

  if (stops.length === 0) {
    if (!weekendBlocked) {
      if ((eligibleUniqueHcpsCount ?? 0) === 0) {
        reasons.push(
          'No active HCP clinics have valid open schedule windows available on this day (after weekly lock & filter rules).'
        );
      } else {
        reasons.push('No valid stops fit inside clinic hours and the 8-hour continuous duty span.');
      }
    }
    reportLines.push(`Date: ${dateIso} (ISO Day ${isoDay})`);
    reportLines.push(`Target: ${targetVisits} visits | Scheduled: 0`);
    if (weeklyLockedCount) {
      reportLines.push(`Excluded by weekly 1-visit-per-HCP lock: ${weeklyLockedCount} HCP(s)`);
    }
    reasons.forEach((r) => reportLines.push(`• ${r}`));

    return {
      id: planDocId(dateIso, variantCode),
      userId,
      dateIso,
      variantCode,
      variantLabel,
      isSelected,
      startMinuteOfDay: 0,
      endMinuteOfDay: 0,
      totalDutySpanMinutes: 0,
      totalDrivingMinutes: 0,
      totalDistanceKm: 0,
      totalWaitingMinutes: 0,
      plannedVisitsCount: 0,
      uniqueHcpsCount: 0,
      feasibilityStatus: 'INFEASIBLE',
      infeasibilityReasonsText: reasons.join(' '),
      validatorReportText: reportLines.join('\n'),
      stops: [],
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // Schedule stops sequentially respecting each clinic's opening window on this day
  const updatedStops: PlanStop[] = [];
  let totalDriving = 0;
  let totalDistance = 0;
  let totalWaiting = 0;
  let dutyStart = 0;
  let currentClock = 0;
  let prevLat: number | null = hasHome ? settings.homeLatitude : null;
  let prevLng: number | null = hasHome ? settings.homeLongitude : null;
  const seenHcps = new Set<string>();
  let windowViolations = 0;
  let duplicateHcpDetected = false;

  for (let i = 0; i < stops.length; i++) {
    const raw = stops[i];
    if (seenHcps.has(raw.hcpTargetId)) {
      duplicateHcpDetected = true;
    }
    seenHcps.add(raw.hcpTargetId);

    const clinic = clinicsByKey.get(raw.clinicKey);
    const effectiveGeo = clinic ? getEffectiveClinicCoordinates(clinic) : null;
    const stopLat = isValidCoordinatePair(raw.latitude, raw.longitude)
      ? raw.latitude
      : effectiveGeo?.latitude ?? null;
    const stopLng = isValidCoordinatePair(raw.latitude, raw.longitude)
      ? raw.longitude
      : effectiveGeo?.longitude ?? null;

    const duration = Math.max(
      5,
      raw.visitDurationMinutes || settings.defaultVisitDurationMinutes || 15
    );
    const effectiveWins = clinic ? getEffectiveClinicWindows(clinic).windows : [];
    const dayWindows = effectiveWins
      .filter((w) => w.dayOfWeek === isoDay)
      .map((w) => {
        const b = getEffectiveWindowBounds(w);
        const start = hasShiftBounds ? Math.max(b.start, shiftStartMinute!) : b.start;
        const end = hasShiftBounds ? Math.min(b.end, shiftEndMinute!) : b.end;
        return { start, end };
      })
      .filter((w) => w.end - w.start >= duration)
      .sort((a, b) => a.start - b.start);

    const travel =
      i === 0
        ? hasHome
          ? estimateTravel(prevLat, prevLng, stopLat, stopLng, settings.trafficSafetyBufferPercent)
          : { distanceKm: 0, travelMinutes: 0, isSameBuilding: false }
        : estimateTravel(prevLat, prevLng, stopLat, stopLng, settings.trafficSafetyBufferPercent);

    let arrival: number;
    let visitStart: number;
    let waitMins = 0;

    if (i === 0) {
      const firstWin = dayWindows[0];
      if (firstWin) {
        if (
          typeof raw.visitStartMinute === 'number' &&
          raw.visitStartMinute >= firstWin.start &&
          raw.visitStartMinute + duration <= firstWin.end
        ) {
          visitStart = raw.visitStartMinute;
        } else {
          visitStart = firstWin.start;
        }
      } else {
        visitStart = raw.visitStartMinute || (hasShiftBounds ? shiftStartMinute! : 10 * 60);
      }
      arrival = visitStart;
      dutyStart = Math.max(0, visitStart - travel.travelMinutes);
    } else {
      arrival = currentClock + travel.travelMinutes;
      const matchingWin = dayWindows.find((w) => Math.max(arrival, w.start) + duration <= w.end);
      if (matchingWin) {
        const earliestValid = Math.max(arrival, matchingWin.start);
        if (
          raw.isLocked &&
          typeof raw.visitStartMinute === 'number' &&
          raw.visitStartMinute >= earliestValid &&
          raw.visitStartMinute + duration <= matchingWin.end
        ) {
          visitStart = raw.visitStartMinute;
        } else {
          visitStart = earliestValid;
        }
        waitMins = Math.max(0, visitStart - arrival);
      } else {
        visitStart = arrival;
        if (dayWindows.length > 0 || (clinic && getEffectiveClinicWindows(clinic).windows.length > 0)) {
          windowViolations++;
          reasons.push(
            `${raw.hcpName} (${raw.clinicLabel}) arrives at ${formatMinuteOfDay(arrival)}, outside clinic/shift hours.`
          );
        }
      }
    }

    const visitEnd = visitStart + duration;
    totalDriving += travel.travelMinutes;
    totalDistance = Number((totalDistance + travel.distanceKm).toFixed(2));
    totalWaiting += waitMins;
    currentClock = visitEnd;
    prevLat = stopLat;
    prevLng = stopLng;

    updatedStops.push({
      ...raw,
      latitude: stopLat,
      longitude: stopLng,
      stopOrder: i + 1,
      arrivalMinute: arrival,
      visitStartMinute: visitStart,
      visitEndMinute: visitEnd,
      visitDurationMinutes: duration,
      travelMinutesFromPrev: travel.travelMinutes,
      distanceKmFromPrev: travel.distanceKm,
    });
  }

  let returnLegMinutes = 0;
  if (settings.returnHomeRequired && hasHome && updatedStops.length > 0) {
    const last = updatedStops[updatedStops.length - 1];
    const ret = estimateTravel(
      last.latitude,
      last.longitude,
      settings.homeLatitude,
      settings.homeLongitude,
      settings.trafficSafetyBufferPercent
    );
    returnLegMinutes = ret.travelMinutes;
    totalDriving += ret.travelMinutes;
    totalDistance = Number((totalDistance + ret.distanceKm).toFixed(2));
  }

  const dutyEnd = currentClock + returnLegMinutes;
  const totalDutySpan = Math.max(0, dutyEnd - dutyStart);

  if (totalDutySpan > maxDuty) {
    reasons.push(
      `Continuous duty span (${totalDutySpan} min) exceeds the ${maxDuty} min (${(maxDuty / 60).toFixed(1)}h) limit.`
    );
  }
  if (duplicateHcpDetected) {
    reasons.push('Duplicate HCP detected in the same daily plan (max 1 visit per HCP per week).');
  }

  let feasibilityStatus: FeasibilityStatus = 'FEASIBLE';
  if (totalDutySpan > maxDuty || windowViolations > 0 || duplicateHcpDetected) {
    feasibilityStatus = 'INFEASIBLE';
  } else if (updatedStops.length < targetVisits) {
    feasibilityStatus = 'PARTIAL_TARGET';
    reasons.push(
      `Scheduled ${updatedStops.length} of ${targetVisits} target visits — Territory Rx never forces invalid stops beyond clinic windows or the ${Math.round(maxDuty / 60)}h duty span.`
    );
  }

  if (exhaustionNote) {
    reasons.push(exhaustionNote);
  }

  reportLines.push(`Variant ${variantCode} (${variantLabel}) — ${dateIso}`);
  reportLines.push(
    `Visits: ${updatedStops.length}/${targetVisits} | Unique HCPs: ${seenHcps.size} | Duty Span: ${totalDutySpan}/${maxDuty} min`
  );
  reportLines.push(
    `Drive: ${totalDriving} min (${totalDistance.toFixed(1)} km) | Wait: ${totalWaiting} min`
  );
  if (weeklyLockedCount) {
    reportLines.push(
      `Weekly lock exclusions: ${weeklyLockedCount} HCP(s) already visited/planned this week`
    );
  }
  if (reasons.length > 0) {
    reportLines.push('Validator Notes:');
    reasons.forEach((r) => reportLines.push(`• ${r}`));
  } else {
    reportLines.push(
      'All stops validated inside clinic hours, sequential same-building rules, and duty span.'
    );
  }

  return {
    id: planDocId(dateIso, variantCode),
    userId,
    dateIso,
    variantCode,
    variantLabel,
    isSelected,
    startMinuteOfDay: dutyStart,
    endMinuteOfDay: dutyEnd,
    totalDutySpanMinutes: totalDutySpan,
    totalDrivingMinutes: totalDriving,
    totalDistanceKm: totalDistance,
    totalWaitingMinutes: totalWaiting,
    plannedVisitsCount: updatedStops.length,
    uniqueHcpsCount: seenHcps.size,
    feasibilityStatus,
    infeasibilityReasonsText: reasons.join(' '),
    validatorReportText: reportLines.join('\n'),
    stops: updatedStops,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

type VariantStrategy = 'BALANCED' | 'MIN_DRIVE' | 'COVERAGE_RECOVERY';

interface EvaluatedCandidateRoute {
  stops: PlanStop[];
  signature: string;
  hcpSetSignature: string;
  aggregateScore: number;
  overlapWithPrevCount: number;
}

/**
 * Validates and schedules an ordered sequence of CandidateClinicSlots strictly inside
 * each slot's [windowStart, windowEnd] and the continuous duty span maxDuty.
 * Returns null if ANY constraint is violated.
 */
function tryScheduleSlotSequenceStrict(
  sequence: CandidateClinicSlot[],
  settings: WorkSettings,
  firstStopStartOffset = 0
): {
  stops: PlanStop[];
  totalDrive: number;
  totalWait: number;
  dutySpan: number;
} | null {
  if (sequence.length === 0) {
    return { stops: [], totalDrive: 0, totalWait: 0, dutySpan: 0 };
  }

  const maxDuty = Math.max(60, settings.maxDutySpanMinutes || 480);
  const hasHome = isValidCoordinatePair(settings.homeLatitude, settings.homeLongitude);

  const stops: PlanStop[] = [];
  let dutyStart = 0;
  let currentClock = 0;
  let prevLat: number | null = hasHome ? settings.homeLatitude : null;
  let prevLng: number | null = hasHome ? settings.homeLongitude : null;
  let totalDrive = 0;
  let totalWait = 0;

  for (let i = 0; i < sequence.length; i++) {
    const slot = sequence[i];
    const travel =
      i === 0
        ? hasHome
          ? estimateTravel(
              prevLat,
              prevLng,
              slot.clinic.latitude,
              slot.clinic.longitude,
              settings.trafficSafetyBufferPercent
            )
          : { distanceKm: 0, travelMinutes: 0, isSameBuilding: false }
        : estimateTravel(
            prevLat,
            prevLng,
            slot.clinic.latitude,
            slot.clinic.longitude,
            settings.trafficSafetyBufferPercent
          );

    let arrival: number;
    let visitStart: number;
    let waitMin = 0;

    if (i === 0) {
      const baseStart =
        slot.isLockedFixed &&
        typeof slot.preferredStartMinute === 'number' &&
        slot.preferredStartMinute >= slot.windowStart &&
        slot.preferredStartMinute + slot.visitDuration <= slot.windowEnd
          ? slot.preferredStartMinute
          : Math.min(
              slot.windowEnd - slot.visitDuration,
              slot.windowStart + Math.max(0, firstStopStartOffset)
            );
      if (baseStart < slot.windowStart || baseStart + slot.visitDuration > slot.windowEnd) {
        return null;
      }
      visitStart = baseStart;
      arrival = visitStart;
      dutyStart = Math.max(0, visitStart - travel.travelMinutes);
    } else {
      arrival = currentClock + travel.travelMinutes;
      let candidateStart = Math.max(arrival, slot.windowStart);
      if (
        slot.isLockedFixed &&
        typeof slot.preferredStartMinute === 'number' &&
        slot.preferredStartMinute >= candidateStart &&
        slot.preferredStartMinute + slot.visitDuration <= slot.windowEnd
      ) {
        candidateStart = slot.preferredStartMinute;
      }
      visitStart = candidateStart;
      waitMin = Math.max(0, visitStart - arrival);
    }

    const visitEnd = visitStart + slot.visitDuration;
    if (visitEnd > slot.windowEnd) {
      return null;
    }

    const returnHomeMin =
      settings.returnHomeRequired && hasHome
        ? estimateTravel(
            slot.clinic.latitude,
            slot.clinic.longitude,
            settings.homeLatitude,
            settings.homeLongitude,
            settings.trafficSafetyBufferPercent
          ).travelMinutes
        : 0;

    if (visitEnd + returnHomeMin - dutyStart > maxDuty) {
      return null;
    }

    totalDrive += travel.travelMinutes;
    totalWait += waitMin;
    currentClock = visitEnd;
    prevLat = slot.clinic.latitude;
    prevLng = slot.clinic.longitude;

    stops.push({
      stopOrder: i + 1,
      hcpTargetId: slot.hcp.targetId,
      hcpName: slot.hcp.name,
      specialty: slot.hcp.specialty,
      clinicKey: slot.clinic.clinicKey,
      clinicLabel: slot.clinic.label,
      zone: slot.clinic.zone || slot.hcp.zone,
      latitude: slot.clinic.latitude,
      longitude: slot.clinic.longitude,
      arrivalMinute: arrival,
      visitStartMinute: visitStart,
      visitEndMinute: visitEnd,
      visitDurationMinutes: slot.visitDuration,
      travelMinutesFromPrev: travel.travelMinutes,
      distanceKmFromPrev: travel.distanceKm,
      executionStatus: slot.fixedExecutionStatus || 'PLANNED',
      isLocked: Boolean(slot.isLockedFixed),
    });
  }

  const last = stops[stops.length - 1];
  const returnLeg =
    settings.returnHomeRequired && hasHome && last
      ? estimateTravel(
          last.latitude,
          last.longitude,
          settings.homeLatitude,
          settings.homeLongitude,
          settings.trafficSafetyBufferPercent
        ).travelMinutes
      : 0;

  const dutySpan = Math.max(0, currentClock + returnLeg - dutyStart);
  if (dutySpan > maxDuty) return null;

  return { stops, totalDrive, totalWait, dutySpan };
}

function buildVariantStopsWithDiversity(params: {
  candidates: CandidateClinicSlot[];
  fixedLockedSlots: CandidateClinicSlot[];
  strategy: VariantStrategy;
  variantIndex: number; // 0 = A, 1 = B, 2 = C
  settings: WorkSettings;
  targetVisits: number;
  eligibleUniqueHcpsCount: number;
  diversitySeed: number;
  previousPlanStopKeys: string[];
  seenSignatures: Set<string>;
  seenHcpSetSignatures: Set<string>;
}): { stops: PlanStop[]; exhaustedAllCombinations: boolean } {
  const {
    candidates,
    fixedLockedSlots,
    strategy,
    variantIndex,
    settings,
    targetVisits,
    eligibleUniqueHcpsCount,
    diversitySeed,
    previousPlanStopKeys,
    seenSignatures,
    seenHcpSetSignatures,
  } = params;

  if ((candidates.length === 0 && fixedLockedSlots.length === 0) || targetVisits <= 0) {
    return { stops: [], exhaustedAllCombinations: false };
  }

  const maxDuty = Math.max(60, settings.maxDutySpanMinutes || 480);
  const hasHome = isValidCoordinatePair(settings.homeLatitude, settings.homeLongitude);

  // Normalize previousPlanStopKeys so we can check both exact stop key ("hcpId:clinicKey") and hcpId
  const prevStopKeySet = new Set<string>();
  const prevHcpIdSet = new Set<string>();
  for (const rawKey of previousPlanStopKeys) {
    const trimmed = String(rawKey || '').trim();
    if (!trimmed) continue;
    prevStopKeySet.add(trimmed);
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      prevHcpIdSet.add(trimmed.slice(0, colonIdx));
    } else {
      prevHcpIdSet.add(trimmed);
    }
  }
  const previousSignature = previousPlanStopKeys.join('>');
  const previousSetSignature = [...previousPlanStopKeys].sort().join('|');

  const hasAlternateEligibleHcps =
    prevStopKeySet.size > 0 && eligibleUniqueHcpsCount > targetVisits;

  // Variant-specific seed so Plan A, Plan B, and Plan C rotate distinctly on every click
  const effectiveSeed = Math.max(0, diversitySeed || 0);
  const variantSeed =
    effectiveSeed > 0 ? effectiveSeed * 31 + variantIndex * 97 + 7 : variantIndex * 97;

  // Soft repeat penalty per variant when alternate eligible HCPs exist
  const seedRepeatPenaltyMag =
    strategy === 'BALANCED' ? 2.8 : strategy === 'MIN_DRIVE' ? 2.2 : 3.5;
  const stepRepeatPenaltyMag =
    strategy === 'BALANCED' ? 24 : strategy === 'MIN_DRIVE' ? 19 : 30;

  const isRepeatedCandidate = (c: CandidateClinicSlot): boolean => {
    const key = `${c.hcp.targetId}:${c.clinic.clinicKey}`;
    const docKey = `${c.hcp.targetId}:${c.clinic.id}`;
    return (
      prevStopKeySet.has(key) ||
      prevStopKeySet.has(docKey) ||
      prevHcpIdSet.has(c.hcp.targetId)
    );
  };

  // Base priority score without diversity perturbation
  const baseScoreSeed = (c: CandidateClinicSlot): number => {
    const hcpTarget = Math.max(1, c.hcp.quarterlyTarget || 8);
    const remScore = Math.min(1, c.remainingVisits / hcpTarget);
    const overdueScore = Math.min(
      1,
      c.daysSinceLastVisit / Math.max(7, settings.overdueThresholdDays || 21)
    );
    const prioScore = Math.min(1, (c.hcp.priorityScore || 50) / 100);
    const specScore = getSpecialtyRankBonus(c.hcp.specialty, settings);
    const homeDist = hasHome
      ? estimateTravel(
          settings.homeLatitude,
          settings.homeLongitude,
          c.clinic.latitude,
          c.clinic.longitude,
          settings.trafficSafetyBufferPercent
        ).distanceKm
      : 0;
    const distScore = 1 / (1 + homeDist / 10);

    if (strategy === 'MIN_DRIVE') {
      return distScore * 0.55 + (1 - c.windowStart / 1440) * 0.25 + remScore * 0.2;
    }
    if (strategy === 'COVERAGE_RECOVERY') {
      return remScore * 0.5 + overdueScore * 0.3 + prioScore * 0.15 + specScore * 0.05;
    }
    const wSpec = (settings.priorityWeightSpecialtyPercent ?? 25) / 100;
    const wRem = (settings.priorityWeightRemainingVisitsPercent ?? 45) / 100;
    const wDist = (settings.priorityWeightTravelDistancePercent ?? 30) / 100;
    return remScore * wRem + specScore * wSpec + distScore * wDist + prioScore * 0.15;
  };

  // Perturbed anchor score incorporating diversitySeed + soft repeat penalty
  const scoreSeed = (c: CandidateClinicSlot, customSeed = variantSeed): number => {
    let score = baseScoreSeed(c);
    if (customSeed > 0) {
      const jitter =
        ((hashStopSeed(c.hcp.targetId, c.clinic.clinicKey, customSeed) % 100) / 100) * 1.5;
      score += jitter;
    }
    if (hasAlternateEligibleHcps && isRepeatedCandidate(c)) {
      score -= seedRepeatPenaltyMag;
    }
    return score;
  };

  const lockedHcpSet = new Set(fixedLockedSlots.map((s) => s.hcp.targetId));
  const unlockedCandidates = candidates.filter((c) => !lockedHcpSet.has(c.hcp.targetId));

  // Score an individual candidate step given previous slot
  const computeStepScore = (
    prevSlot: CandidateClinicSlot | null,
    cand: CandidateClinicSlot,
    travelMin: number,
    isSameBuilding: boolean,
    waitMin: number,
    customSeed = variantSeed
  ): number => {
    const sameBuildingBonus = isSameBuilding ? 45 : 0;
    const prevZone = prevSlot ? prevSlot.clinic.zone || prevSlot.hcp.zone : '';
    const candZone = cand.clinic.zone || cand.hcp.zone;
    const sameZoneBonus = candZone && prevZone && candZone === prevZone ? 12 : 0;
    const hcpTarget = Math.max(1, cand.hcp.quarterlyTarget || 8);
    const urgencyRatio = cand.remainingVisits / hcpTarget;
    const urgency =
      urgencyRatio * 40 +
      cand.remainingVisits * 6 +
      Math.min(30, cand.daysSinceLastVisit * 0.4) +
      (cand.hcp.priorityScore || 50) * 0.2;

    let stepScore: number;
    if (strategy === 'MIN_DRIVE') {
      stepScore =
        sameBuildingBonus + sameZoneBonus - travelMin * 3.2 - waitMin * 1.1 + urgency * 0.35;
    } else if (strategy === 'COVERAGE_RECOVERY') {
      stepScore =
        urgency * 2.2 + sameBuildingBonus * 0.6 - travelMin * 1.1 - waitMin * 0.85;
    } else {
      stepScore =
        urgency * 1.15 +
        sameBuildingBonus +
        sameZoneBonus -
        travelMin * 2.0 -
        waitMin * 0.95;
    }

    if (customSeed > 0) {
      const stepJitter =
        ((hashStopSeed(cand.hcp.targetId, cand.clinic.clinicKey, customSeed + 19) % 100) /
          100) *
        8.5;
      stepScore += stepJitter;
    }

    if (hasAlternateEligibleHcps && isRepeatedCandidate(cand)) {
      stepScore -= stepRepeatPenaltyMag;
    }

    return stepScore;
  };

  const evaluatedRoutes = new Map<string, EvaluatedCandidateRoute>();

  const recordCandidateRoute = (
    stops: PlanStop[],
    totalDrive: number,
    totalWait: number,
    prioritySum: number
  ) => {
    if (stops.length === 0) return;
    const sig = getRouteSignature(stops);
    const setSig = getRouteHcpSetSignature(stops);
    const overlapWithPrevCount = stops.filter((s) => {
      const k = `${s.hcpTargetId}:${s.clinicKey}`;
      return !s.isLocked && (prevStopKeySet.has(k) || prevHcpIdSet.has(s.hcpTargetId));
    }).length;

    const aggregateScore =
      stops.length * 100 +
      prioritySum * 15 -
      totalDrive * (strategy === 'MIN_DRIVE' ? 1.5 : 0.6) -
      totalWait * 0.35 -
      (hasAlternateEligibleHcps ? overlapWithPrevCount * 8 : 0);

    const existing = evaluatedRoutes.get(sig);
    if (!existing || aggregateScore > existing.aggregateScore) {
      evaluatedRoutes.set(sig, {
        stops,
        signature: sig,
        hcpSetSignature: setSig,
        aggregateScore,
        overlapWithPrevCount,
      });
    }
  };

  // CASE A: Locked/Completed stops exist on this day -> keep them fixed and build unlocked stops around them
  if (fixedLockedSlots.length > 0) {
    const orderedFixed = [...fixedLockedSlots].sort(
      (a, b) =>
        (a.preferredStartMinute ?? a.windowStart) - (b.preferredStartMinute ?? b.windowStart)
    );

    // Run multiple seeded passes to generate diverse valid completions around the locked stops
    const passSeeds = [
      variantSeed,
      variantSeed + 101,
      variantSeed + 211,
      variantSeed + 307,
      variantSeed + 401,
      variantSeed + 509,
    ];

    for (const pSeed of passSeeds) {
      let currentSeq = [...orderedFixed];
      const usedHcps = new Set<string>(orderedFixed.map((s) => s.hcp.targetId));
      let prioritySum = orderedFixed.reduce((acc, s) => acc + baseScoreSeed(s), 0);

      while (currentSeq.length < targetVisits) {
        let bestInsertion: {
          nextSeq: CandidateClinicSlot[];
          cand: CandidateClinicSlot;
          score: number;
        } | null = null;

        for (const cand of unlockedCandidates) {
          if (usedHcps.has(cand.hcp.targetId)) continue;

          // Try inserting cand at every position 0..currentSeq.length
          for (let pos = 0; pos <= currentSeq.length; pos++) {
            const trialSeq = [
              ...currentSeq.slice(0, pos),
              cand,
              ...currentSeq.slice(pos),
            ];
            const scheduled = tryScheduleSlotSequenceStrict(trialSeq, settings);
            if (!scheduled) continue;

            const prevSlot = pos > 0 ? trialSeq[pos - 1] : null;
            const placedStop = scheduled.stops[pos];
            const prevStop = pos > 0 ? scheduled.stops[pos - 1] : null;
            const waitMin =
              prevStop
                ? Math.max(
                    0,
                    placedStop.visitStartMinute -
                      (prevStop.visitEndMinute + placedStop.travelMinutesFromPrev)
                  )
                : 0;
            const isSameBuilding =
              pos > 0 &&
              placedStop.travelMinutesFromPrev === 0 &&
              placedStop.distanceKmFromPrev === 0;

            const stepScore =
              computeStepScore(
                prevSlot,
                cand,
                placedStop.travelMinutesFromPrev,
                isSameBuilding,
                waitMin,
                pSeed
              ) -
              scheduled.totalDrive * 0.25 -
              scheduled.totalWait * 0.1;

            if (!bestInsertion || stepScore > bestInsertion.score) {
              bestInsertion = {
                nextSeq: trialSeq,
                cand,
                score: stepScore,
              };
            }
          }
        }

        if (!bestInsertion) break;
        currentSeq = bestInsertion.nextSeq;
        usedHcps.add(bestInsertion.cand.hcp.targetId);
        prioritySum += scoreSeed(bestInsertion.cand, pSeed);
      }

      const finalScheduled = tryScheduleSlotSequenceStrict(currentSeq, settings);
      if (finalScheduled) {
        recordCandidateRoute(
          finalScheduled.stops,
          finalScheduled.totalDrive,
          finalScheduled.totalWait,
          prioritySum
        );
      }
    }
  } else {
    // CASE B: No locked stops -> explore top anchor seeds + rotated seeds
    const sortedSeeds = [...unlockedCandidates].sort(
      (a, b) => scoreSeed(b, variantSeed) - scoreSeed(a, variantSeed)
    );
    const maxSeedsToTry = Math.min(20, sortedSeeds.length);
    const seedPool = sortedSeeds.slice(0, maxSeedsToTry);

    for (let sIdx = 0; sIdx < seedPool.length; sIdx++) {
      const seed = seedPool[sIdx];
      const runSeed = variantSeed + sIdx * 37;
      const usedHcps = new Set<string>([seed.hcp.targetId]);
      const homeTravel = hasHome
        ? estimateTravel(
            settings.homeLatitude,
            settings.homeLongitude,
            seed.clinic.latitude,
            seed.clinic.longitude,
            settings.trafficSafetyBufferPercent
          )
        : { distanceKm: 0, travelMinutes: 0, isSameBuilding: false };

      const dutyStart = Math.max(0, seed.windowStart - homeTravel.travelMinutes);
      let currentClock = seed.windowStart + seed.visitDuration;
      let curLat = seed.clinic.latitude;
      let curLng = seed.clinic.longitude;
      let totalDrive = homeTravel.travelMinutes;
      let totalWait = 0;

      const seedReturn =
        settings.returnHomeRequired && hasHome
          ? estimateTravel(
              curLat,
              curLng,
              settings.homeLatitude,
              settings.homeLongitude,
              settings.trafficSafetyBufferPercent
            ).travelMinutes
          : 0;
      if (currentClock + seedReturn - dutyStart > maxDuty) {
        continue;
      }

      const route: PlanStop[] = [
        {
          stopOrder: 1,
          hcpTargetId: seed.hcp.targetId,
          hcpName: seed.hcp.name,
          specialty: seed.hcp.specialty,
          clinicKey: seed.clinic.clinicKey,
          clinicLabel: seed.clinic.label,
          zone: seed.clinic.zone || seed.hcp.zone,
          latitude: seed.clinic.latitude,
          longitude: seed.clinic.longitude,
          arrivalMinute: seed.windowStart,
          visitStartMinute: seed.windowStart,
          visitEndMinute: currentClock,
          visitDurationMinutes: seed.visitDuration,
          travelMinutesFromPrev: homeTravel.travelMinutes,
          distanceKmFromPrev: homeTravel.distanceKm,
          executionStatus: 'PLANNED',
          isLocked: false,
        },
      ];

      let prevSlot: CandidateClinicSlot = seed;
      let routePrioritySum = scoreSeed(seed, runSeed);

      while (route.length < targetVisits) {
        let bestNext: {
          slot: CandidateClinicSlot;
          arrival: number;
          visitStart: number;
          visitEnd: number;
          travelMin: number;
          distKm: number;
          waitMin: number;
          stepScore: number;
        } | null = null;

        for (const cand of unlockedCandidates) {
          if (usedHcps.has(cand.hcp.targetId)) continue;

          const travel = estimateTravel(
            curLat,
            curLng,
            cand.clinic.latitude,
            cand.clinic.longitude,
            settings.trafficSafetyBufferPercent
          );
          const arrival = currentClock + travel.travelMinutes;
          const visitStart = Math.max(arrival, cand.windowStart);
          const visitEnd = visitStart + cand.visitDuration;

          // Clinic window check
          if (visitEnd > cand.windowEnd) continue;

          // Continuous duty span check (including return home if enabled)
          const returnHomeMin =
            settings.returnHomeRequired && hasHome
              ? estimateTravel(
                  cand.clinic.latitude,
                  cand.clinic.longitude,
                  settings.homeLatitude,
                  settings.homeLongitude,
                  settings.trafficSafetyBufferPercent
                ).travelMinutes
              : 0;

          if (visitEnd + returnHomeMin - dutyStart > maxDuty) continue;

          const waitMin = Math.max(0, visitStart - arrival);
          const stepScore = computeStepScore(
            prevSlot,
            cand,
            travel.travelMinutes,
            travel.isSameBuilding,
            waitMin,
            runSeed + route.length * 17
          );

          if (!bestNext || stepScore > bestNext.stepScore) {
            bestNext = {
              slot: cand,
              arrival,
              visitStart,
              visitEnd,
              travelMin: travel.travelMinutes,
              distKm: travel.distanceKm,
              waitMin,
              stepScore,
            };
          }
        }

        if (!bestNext) break;

        usedHcps.add(bestNext.slot.hcp.targetId);
        currentClock = bestNext.visitEnd;
        curLat = bestNext.slot.clinic.latitude;
        curLng = bestNext.slot.clinic.longitude;
        totalDrive += bestNext.travelMin;
        totalWait += bestNext.waitMin;
        prevSlot = bestNext.slot;
        routePrioritySum += scoreSeed(bestNext.slot, runSeed);

        route.push({
          stopOrder: route.length + 1,
          hcpTargetId: bestNext.slot.hcp.targetId,
          hcpName: bestNext.slot.hcp.name,
          specialty: bestNext.slot.hcp.specialty,
          clinicKey: bestNext.slot.clinic.clinicKey,
          clinicLabel: bestNext.slot.clinic.label,
          zone: bestNext.slot.clinic.zone || bestNext.slot.hcp.zone,
          latitude: bestNext.slot.clinic.latitude,
          longitude: bestNext.slot.clinic.longitude,
          arrivalMinute: bestNext.arrival,
          visitStartMinute: bestNext.visitStart,
          visitEndMinute: bestNext.visitEnd,
          visitDurationMinutes: bestNext.slot.visitDuration,
          travelMinutesFromPrev: bestNext.travelMin,
          distanceKmFromPrev: bestNext.distKm,
          executionStatus: 'PLANNED',
          isLocked: false,
        });
      }

      recordCandidateRoute(route, totalDrive, totalWait, routePrioritySum);
    }
  }

  const allRoutes = Array.from(evaluatedRoutes.values());
  if (allRoutes.length === 0) {
    return { stops: [], exhaustedAllCombinations: false };
  }

  // Find maximum achievable visit count among valid candidate routes
  const maxStopsFound = Math.max(...allRoutes.map((r) => r.stops.length));
  const topLengthRoutes = allRoutes.filter((r) => r.stops.length === maxStopsFound);

  // Sort top-length routes:
  // 1) Not in seenSignatures (distinct across Plan A, Plan B, Plan C)
  // 2) Different HCP set or sequence from previousPlanStopKeys
  // 3) Lower overlap with previousPlanStopKeys when alternate HCPs exist
  // 4) Higher aggregateScore
  topLengthRoutes.sort((a, b) => {
    const aUnseen = !seenSignatures.has(a.signature) ? 1 : 0;
    const bUnseen = !seenSignatures.has(b.signature) ? 1 : 0;
    if (aUnseen !== bUnseen) return bUnseen - aUnseen;

    if (previousSignature) {
      const aDiffPrevSeq = a.signature !== previousSignature ? 1 : 0;
      const bDiffPrevSeq = b.signature !== previousSignature ? 1 : 0;
      if (aDiffPrevSeq !== bDiffPrevSeq) return bDiffPrevSeq - aDiffPrevSeq;

      const aDiffPrevSet = a.hcpSetSignature !== previousSetSignature ? 1 : 0;
      const bDiffPrevSet = b.hcpSetSignature !== previousSetSignature ? 1 : 0;
      if (aDiffPrevSet !== bDiffPrevSet) return bDiffPrevSet - aDiffPrevSet;
    }

    const aUnseenSet = !seenHcpSetSignatures.has(a.hcpSetSignature) ? 1 : 0;
    const bUnseenSet = !seenHcpSetSignatures.has(b.hcpSetSignature) ? 1 : 0;
    if (aUnseenSet !== bUnseenSet) return bUnseenSet - aUnseenSet;

    return b.aggregateScore - a.aggregateScore;
  });

  let chosen = topLengthRoutes[0];
  let exhaustedAllCombinations = false;

  // GRACEFUL EXHAUSTION FALLBACK:
  // If chosen route still matches previousSignature or seenSignatures (e.g. only 1 feasible HCP set exists),
  // try alternate feasible visit orderings or start-time offsets of the chosen stops!
  if (
    (previousSignature && chosen.signature === previousSignature) ||
    seenSignatures.has(chosen.signature)
  ) {
    const slotByKey = new Map<string, CandidateClinicSlot>();
    for (const c of [...fixedLockedSlots, ...unlockedCandidates]) {
      if (!slotByKey.has(`${c.hcp.targetId}:${c.clinic.clinicKey}`)) {
        slotByKey.set(`${c.hcp.targetId}:${c.clinic.clinicKey}`, c);
      }
    }
    const baseSlots = chosen.stops
      .map((s) => slotByKey.get(`${s.hcpTargetId}:${s.clinicKey}`))
      .filter((s): s is CandidateClinicSlot => Boolean(s));

    let foundAlternateOrder = false;

    if (baseSlots.length >= 2) {
      // Generate rotated / swapped permutations of unlocked slots while preserving any locked stops
      const candidatePermutations: CandidateClinicSlot[][] = [];
      for (let rot = 1; rot < baseSlots.length; rot++) {
        candidatePermutations.push([
          ...baseSlots.slice(rot),
          ...baseSlots.slice(0, rot),
        ]);
      }
      candidatePermutations.push([...baseSlots].reverse());
      for (let i = 0; i < baseSlots.length - 1; i++) {
        const swapped = [...baseSlots];
        const tmp = swapped[i];
        swapped[i] = swapped[i + 1];
        swapped[i + 1] = tmp;
        candidatePermutations.push(swapped);
      }

      // Deterministic rotation based on diversitySeed
      const startOffset = effectiveSeed % Math.max(1, candidatePermutations.length);
      for (let k = 0; k < candidatePermutations.length; k++) {
        const perm =
          candidatePermutations[(startOffset + k) % candidatePermutations.length];
        const scheduled = tryScheduleSlotSequenceStrict(perm, settings);
        if (!scheduled) continue;
        const permSig = getRouteSignature(scheduled.stops);
        if (
          permSig !== previousSignature &&
          !seenSignatures.has(permSig)
        ) {
          chosen = {
            stops: scheduled.stops,
            signature: permSig,
            hcpSetSignature: getRouteHcpSetSignature(scheduled.stops),
            aggregateScore: chosen.aggregateScore - 1,
            overlapWithPrevCount: chosen.overlapWithPrevCount,
          };
          foundAlternateOrder = true;
          break;
        }
      }
    }

    // If only 1 stop or all order permutations have been shown/invalid, try shifted valid start time
    if (!foundAlternateOrder && baseSlots.length > 0 && variantIndex === 0 && previousSignature) {
      const timeOffsets = [15, 30, 45, 60];
      const offsetChoice = timeOffsets[effectiveSeed % timeOffsets.length];
      const shifted = tryScheduleSlotSequenceStrict(baseSlots, settings, offsetChoice);
      if (shifted) {
        chosen = {
          ...chosen,
          stops: shifted.stops,
        };
      }
      exhaustedAllCombinations = true;
    } else if (!foundAlternateOrder && variantIndex === 0 && previousSignature) {
      exhaustedAllCombinations = true;
    }
  }

  seenSignatures.add(chosen.signature);
  seenHcpSetSignatures.add(chosen.hcpSetSignature);

  return {
    stops: chosen.stops,
    exhaustedAllCombinations,
  };
}

/**
 * Generates Plans A, B, and C for a single day while honoring every Territory Rx rule,
 * with controlled diversity & rotation on every click of "AI Route Plan".
 */
export function optimizeDailyPlans(input: OptimizeDayInput): DailyPlan[] {
  const {
    userId,
    dateIso,
    hcps,
    clinics,
    visits,
    weeklyLocks,
    settings,
    zoneFilter,
    targetOverride,
    shiftStartMinute,
    shiftEndMinute,
    extraBlockedHcpIds,
    diversitySeed = 0,
    previousPlanStopKeys = [],
    lockedStops = [],
    existingWeekPlans = [],
  } = input;

  const targetVisits = Math.max(1, targetOverride ?? settings.dailyHcpTarget ?? 8);
  const isoDay = getIsoDayOfWeek(dateIso);
  const isWeekend = (settings.weekendDaysIso || []).includes(isoDay);
  const { weekStartIso, weekEndIso } = getWeekBounds(dateIso, settings.firstDayOfWeekIso);

  // Resolve effective GPS coordinates on the fly for all clinics (supporting both VERIFIED & EXTRACTED_URL)
  const resolvedClinics: Clinic[] = clinics.map((c) => {
    const geo = getEffectiveClinicCoordinates(c);
    return {
      ...c,
      latitude: geo.latitude,
      longitude: geo.longitude,
      googleMapsUrl: geo.googleMapsUrl || c.googleMapsUrl,
      geocodingStatus: geo.geocodingStatus,
    };
  });

  const clinicsByKey = new Map<string, Clinic>();
  for (const c of resolvedClinics) {
    clinicsByKey.set(c.clinicKey, c);
  }

  // Weekly 1-visit-per-HCP enforcement across ALL clinics of an HCP:
  // 1) extraBlockedHcpIds
  // 2) weeklyLocks on other days of the same calendar week
  // 3) visits (PLANNED or COMPLETED) on other days of the same calendar week
  // 4) existingWeekPlans (selected plan on another day of the same calendar week)
  const lockedHcpIds = new Set<string>(
    extraBlockedHcpIds ? Array.from(extraBlockedHcpIds) : []
  );

  if (settings.enforceWeeklyHcpVisitLimit !== false) {
    for (const lock of weeklyLocks) {
      if (
        lock.weekStartIso === weekStartIso &&
        lock.plannedDateIso !== dateIso &&
        (lock.status === 'PLANNED' ||
          lock.status === 'COMPLETED' ||
          lock.status === 'CONFIRMED')
      ) {
        lockedHcpIds.add(lock.hcpTargetId);
      }
    }

    for (const v of visits) {
      if (
        v.plannedDateIso >= weekStartIso &&
        v.plannedDateIso <= weekEndIso &&
        v.plannedDateIso !== dateIso &&
        (v.status === 'PLANNED' || v.status === 'COMPLETED')
      ) {
        lockedHcpIds.add(v.hcpTargetId);
      }
    }

    if (existingWeekPlans.length > 0) {
      const plansByOtherDate = new Map<string, DailyPlan[]>();
      for (const p of existingWeekPlans) {
        if (
          p.dateIso >= weekStartIso &&
          p.dateIso <= weekEndIso &&
          p.dateIso !== dateIso
        ) {
          const list = plansByOtherDate.get(p.dateIso) || [];
          list.push(p);
          plansByOtherDate.set(p.dateIso, list);
        }
      }
      for (const [, dayPlans] of plansByOtherDate.entries()) {
        const selectedForDay =
          dayPlans.find((p) => p.isSelected) ||
          dayPlans.find((p) => p.variantCode === 'A');
        if (selectedForDay) {
          for (const s of selectedForDay.stops || []) {
            if (
              s.executionStatus !== 'CANCELLED' &&
              s.executionStatus !== 'NOT_COMPLETED'
            ) {
              lockedHcpIds.add(s.hcpTargetId);
            }
          }
        }
      }
    }
  }

  const activeHcps = hcps.filter((h) => h.isActive && !h.isDeleted);
  const activeHcpMap = new Map<string, Hcp>(activeHcps.map((h) => [h.targetId, h]));

  const hasShiftBounds =
    typeof shiftStartMinute === 'number' &&
    typeof shiftEndMinute === 'number' &&
    shiftEndMinute > shiftStartMinute;

  // Build fixed locked/completed slots for selectedDateIso so they are preserved on regeneration
  const fixedLockedSlots: CandidateClinicSlot[] = [];
  const fixedLockedHcpIds = new Set<string>();

  if (!isWeekend && lockedStops.length > 0) {
    for (const stop of lockedStops) {
      if (!stop.isLocked && stop.executionStatus !== 'COMPLETED') continue;
      if (fixedLockedHcpIds.has(stop.hcpTargetId)) continue;

      const hcp = activeHcpMap.get(stop.hcpTargetId);
      const clinic = clinicsByKey.get(stop.clinicKey);
      if (!hcp || !clinic) continue;
      if (
        !isValidCoordinatePair(clinic.latitude, clinic.longitude) ||
        (clinic.geocodingStatus !== 'VERIFIED' &&
          clinic.geocodingStatus !== 'EXTRACTED_URL')
      ) {
        continue;
      }

      const effectiveSchedule = getEffectiveClinicWindows(clinic);
      const dayWindows = effectiveSchedule.windows.filter((w) => w.dayOfWeek === isoDay);
      if (dayWindows.length === 0) continue;

      const duration = Math.max(
        5,
        stop.visitDurationMinutes ||
          hcp.defaultVisitDurationMinutes ||
          settings.defaultVisitDurationMinutes ||
          15
      );

      // Find window matching stop's visitStartMinute or earliest valid window on this day
      let matchedWin: { win: ClinicWindow; start: number; end: number } | null = null;
      for (const win of dayWindows) {
        const rawBounds = getEffectiveWindowBounds(win);
        const start = hasShiftBounds
          ? Math.max(rawBounds.start, shiftStartMinute!)
          : rawBounds.start;
        const end = hasShiftBounds
          ? Math.min(rawBounds.end, shiftEndMinute!)
          : rawBounds.end;
        if (end - start < duration) continue;
        if (
          !matchedWin ||
          (stop.visitStartMinute >= start && stop.visitStartMinute + duration <= end)
        ) {
          matchedWin = { win, start, end };
        }
      }

      if (!matchedWin) continue;

      const cov = computeHcpQuarterCoverage(
        hcp,
        visits,
        settings.currentQuarterLabel,
        dateIso
      );

      fixedLockedHcpIds.add(hcp.targetId);
      fixedLockedSlots.push({
        hcp,
        clinic,
        window: matchedWin.win,
        windowStart: matchedWin.start,
        windowEnd: matchedWin.end,
        remainingVisits: Math.max(1, cov.remaining),
        completedThisQuarter: cov.completed,
        daysSinceLastVisit: cov.daysSinceLastVisit,
        visitDuration: duration,
        priorityWeight: hcp.priorityScore || 50,
        isLockedFixed: true,
        preferredStartMinute: stop.visitStartMinute,
        fixedExecutionStatus: stop.executionStatus || 'PLANNED',
      });
    }
  }

  const candidates: CandidateClinicSlot[] = [];
  const eligibleUniqueHcps = new Set<string>(fixedLockedHcpIds);

  if (!isWeekend) {
    for (const clinic of resolvedClinics) {
      if (!clinic.isActive) continue;
      // HARD CONSTRAINT 2: Only clinics with valid GPS (VERIFIED or EXTRACTED_URL)
      if (
        !isValidCoordinatePair(clinic.latitude, clinic.longitude) ||
        (clinic.geocodingStatus !== 'VERIFIED' &&
          clinic.geocodingStatus !== 'EXTRACTED_URL')
      ) {
        continue;
      }

      const hcp = activeHcpMap.get(clinic.hcpTargetId);
      if (!hcp) continue;
      // HARD CONSTRAINT 4: Only unlocked doctors NOT already completed or scheduled on another day of the same week
      if (lockedHcpIds.has(hcp.targetId)) continue;
      if (fixedLockedHcpIds.has(hcp.targetId)) continue;

      const effectiveZone = (clinic.zone || hcp.zone || '').trim();
      if (
        zoneFilter &&
        zoneFilter !== 'ALL' &&
        effectiveZone.toLowerCase() !== zoneFilter.toLowerCase()
      ) {
        continue;
      }

      // HARD CONSTRAINT 1: Only clinics with valid parsed visiting windows overlapping shift
      const effectiveSchedule = getEffectiveClinicWindows(clinic);
      if (effectiveSchedule.windows.length === 0) continue;
      if (
        !clinic.isManualUserConfirmed &&
        !clinic.userConfirmedSchedule &&
        effectiveSchedule.parseStatus === 'UNPARSED'
      ) {
        continue;
      }

      const dayWindows = effectiveSchedule.windows.filter((w) => w.dayOfWeek === isoDay);
      if (dayWindows.length === 0) continue;

      // HARD CONSTRAINT 3: Only doctors with remainingVisits > 0
      const cov = computeHcpQuarterCoverage(
        hcp,
        visits,
        settings.currentQuarterLabel,
        dateIso
      );
      const targetForHcp = Math.max(1, hcp.quarterlyTarget || 8);
      if (cov.completed >= targetForHcp || cov.remaining <= 0) continue;

      const duration = Math.max(
        5,
        hcp.defaultVisitDurationMinutes || settings.defaultVisitDurationMinutes || 15
      );

      for (const win of dayWindows) {
        const rawBounds = getEffectiveWindowBounds(win);
        const start = hasShiftBounds
          ? Math.max(rawBounds.start, shiftStartMinute!)
          : rawBounds.start;
        const end = hasShiftBounds
          ? Math.min(rawBounds.end, shiftEndMinute!)
          : rawBounds.end;
        if (end - start < duration) continue;
        eligibleUniqueHcps.add(hcp.targetId);
        candidates.push({
          hcp,
          clinic,
          window: win,
          windowStart: start,
          windowEnd: end,
          remainingVisits: cov.remaining,
          completedThisQuarter: cov.completed,
          daysSinceLastVisit: cov.daysSinceLastVisit,
          visitDuration: duration,
          priorityWeight: hcp.priorityScore || 50,
        });
      }
    }
  }

  const variants: Array<{
    code: 'A' | 'B' | 'C';
    label: string;
    strategy: VariantStrategy;
    isSelected: boolean;
  }> = [
    { code: 'A', label: 'Balanced Priority', strategy: 'BALANCED', isSelected: true },
    { code: 'B', label: 'Minimum Drive Cluster', strategy: 'MIN_DRIVE', isSelected: false },
    { code: 'C', label: 'Coverage Recovery', strategy: 'COVERAGE_RECOVERY', isSelected: false },
  ];

  const seenSignatures = new Set<string>();
  const seenHcpSetSignatures = new Set<string>();

  return variants.map((v, idx) => {
    const built = isWeekend
      ? { stops: [] as PlanStop[], exhaustedAllCombinations: false }
      : buildVariantStopsWithDiversity({
          candidates,
          fixedLockedSlots,
          strategy: v.strategy,
          variantIndex: idx,
          settings,
          targetVisits,
          eligibleUniqueHcpsCount: eligibleUniqueHcps.size,
          diversitySeed,
          previousPlanStopKeys,
          seenSignatures,
          seenHcpSetSignatures,
        });

    return recomputePlanFromStops({
      userId,
      dateIso,
      variantCode: v.code,
      variantLabel: v.label,
      isSelected: v.isSelected,
      stops: built.stops,
      clinicsByKey,
      settings,
      targetVisits,
      eligibleUniqueHcpsCount: eligibleUniqueHcps.size,
      weeklyLockedCount: lockedHcpIds.size,
      weekendBlocked: isWeekend,
      shiftStartMinute,
      shiftEndMinute,
      exhaustionNote: built.exhaustedAllCombinations
        ? EXHAUSTED_COMBINATIONS_NOTE
        : undefined,
    });
  });
}

// 1:1 alias matching Android Territory Rx optimizeDay(...)
export const optimizeDay = optimizeDailyPlans;

/**
 * Generates an entire working week of Plan A/B/C sets while strictly preventing
 * any HCP from being scheduled more than once in the same calendar week across all clinics.
 */
export function optimizeWeeklyPlans(input: Omit<OptimizeDayInput, 'extraBlockedHcpIds'>): {
  weekStartIso: string;
  weekEndIso: string;
  byDate: Record<string, DailyPlan[]>;
  allPlans: DailyPlan[];
} {
  const { weekStartIso, weekEndIso } = getWeekBounds(
    input.dateIso,
    input.settings.firstDayOfWeekIso
  );
  const weekDays = getWeekDates(input.dateIso, input.settings.firstDayOfWeekIso);
  const usedInWeek = new Set<string>();
  const byDate: Record<string, DailyPlan[]> = {};
  const allPlans: DailyPlan[] = [];

  for (const day of weekDays) {
    const isWeekend = (input.settings.weekendDaysIso || []).includes(day.isoDay);
    if (isWeekend) {
      byDate[day.dateIso] = [];
      continue;
    }

    const dayPlans = optimizeDailyPlans({
      ...input,
      dateIso: day.dateIso,
      extraBlockedHcpIds:
        input.settings.enforceWeeklyHcpVisitLimit !== false ? usedInWeek : undefined,
    });

    // Reserve HCPs chosen by Plan A so subsequent days in the same week respect the 1x/week rule
    const primaryPlan = dayPlans[0];
    if (primaryPlan) {
      for (const s of primaryPlan.stops) {
        usedInWeek.add(s.hcpTargetId);
      }
    }

    byDate[day.dateIso] = dayPlans;
    allPlans.push(...dayPlans);
  }

  return { weekStartIso, weekEndIso, byDate, allPlans };
}
