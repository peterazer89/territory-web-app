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
  } = params;

  const isoDay = getIsoDayOfWeek(dateIso);
  const maxDuty = Math.max(60, settings.maxDutySpanMinutes || 480);
  const hasHome = isValidCoordinatePair(settings.homeLatitude, settings.homeLongitude);

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

    const effectiveWins = clinic ? getEffectiveClinicWindows(clinic).windows : [];
    const dayWindows = effectiveWins
      .filter((w) => w.dayOfWeek === isoDay)
      .map(getEffectiveWindowBounds)
      .sort((a, b) => a.start - b.start);

    const duration = Math.max(5, raw.visitDurationMinutes || settings.defaultVisitDurationMinutes || 15);
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
      visitStart = firstWin ? firstWin.start : raw.visitStartMinute || 10 * 60;
      arrival = visitStart;
      dutyStart = Math.max(0, visitStart - travel.travelMinutes);
    } else {
      arrival = currentClock + travel.travelMinutes;
      // Pick earliest clinic window that can accommodate the visit starting at >= arrival
      const matchingWin = dayWindows.find((w) => Math.max(arrival, w.start) + duration <= w.end);
      if (matchingWin) {
        visitStart = Math.max(arrival, matchingWin.start);
        waitMins = Math.max(0, visitStart - arrival);
      } else {
        visitStart = arrival;
        if (dayWindows.length > 0) {
          windowViolations++;
          reasons.push(
            `${raw.hcpName} (${raw.clinicLabel}) arrives at ${formatMinuteOfDay(arrival)}, outside clinic hours.`
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

  reportLines.push(`Variant ${variantCode} (${variantLabel}) — ${dateIso}`);
  reportLines.push(
    `Visits: ${updatedStops.length}/${targetVisits} | Unique HCPs: ${seenHcps.size} | Duty Span: ${totalDutySpan}/${maxDuty} min`
  );
  reportLines.push(
    `Drive: ${totalDriving} min (${totalDistance.toFixed(1)} km) | Wait: ${totalWaiting} min`
  );
  if (weeklyLockedCount) {
    reportLines.push(`Weekly lock exclusions: ${weeklyLockedCount} HCP(s) already visited/planned this week`);
  }
  if (reasons.length > 0) {
    reportLines.push('Validator Notes:');
    reasons.forEach((r) => reportLines.push(`• ${r}`));
  } else {
    reportLines.push('All stops validated inside clinic hours, sequential same-building rules, and duty span.');
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

function buildVariantStops(
  candidates: CandidateClinicSlot[],
  strategy: VariantStrategy,
  settings: WorkSettings,
  targetVisits: number
): PlanStop[] {
  if (candidates.length === 0 || targetVisits <= 0) return [];

  const maxDuty = Math.max(60, settings.maxDutySpanMinutes || 480);
  const hasHome = isValidCoordinatePair(settings.homeLatitude, settings.homeLongitude);

  // Pick anchor candidates ordered by strategy
  const scoreSeed = (c: CandidateClinicSlot): number => {
    const hcpTarget = Math.max(1, c.hcp.quarterlyTarget || 8);
    const remScore = Math.min(1, c.remainingVisits / hcpTarget);
    const overdueScore = Math.min(1, c.daysSinceLastVisit / Math.max(7, settings.overdueThresholdDays || 21));
    const prioScore = Math.min(1, (c.hcp.priorityScore || 50) / 100);
    const specScore = getSpecialtyRankBonus(c.hcp.specialty, settings);
    const homeDist = hasHome
      ? estimateTravel(settings.homeLatitude, settings.homeLongitude, c.clinic.latitude, c.clinic.longitude, settings.trafficSafetyBufferPercent).distanceKm
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

  // Try top few opening-window anchors to maximize valid feasible count within 8h continuous duty span
  const sortedSeeds = [...candidates].sort((a, b) => scoreSeed(b) - scoreSeed(a));
  const seedPool = sortedSeeds.slice(0, Math.min(10, sortedSeeds.length));

  let bestRoute: PlanStop[] = [];
  let bestScore = -Infinity;

  for (const seed of seedPool) {
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

    // Check if even seed + return home fits duty span
    const seedReturn =
      settings.returnHomeRequired && hasHome
        ? estimateTravel(curLat, curLng, settings.homeLatitude, settings.homeLongitude, settings.trafficSafetyBufferPercent).travelMinutes
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

    let routePrioritySum = scoreSeed(seed);

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

      for (const cand of candidates) {
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

        // 8-hour continuous duty span check (including return home if enabled)
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
        const sameBuildingBonus = travel.isSameBuilding ? 45 : 0;
        const sameZoneBonus = cand.clinic.zone && cand.clinic.zone === route[route.length - 1].zone ? 12 : 0;
        const hcpTarget = Math.max(1, cand.hcp.quarterlyTarget || 8);
        const urgencyRatio = cand.remainingVisits / hcpTarget;
        const urgency =
          urgencyRatio * 40 +
          cand.remainingVisits * 6 +
          Math.min(30, cand.daysSinceLastVisit * 0.4) +
          (cand.hcp.priorityScore || 50) * 0.2;

        let stepScore: number;
        if (strategy === 'MIN_DRIVE') {
          stepScore = sameBuildingBonus + sameZoneBonus - travel.travelMinutes * 3.2 - waitMin * 1.1 + urgency * 0.35;
        } else if (strategy === 'COVERAGE_RECOVERY') {
          stepScore = urgency * 2.2 + sameBuildingBonus * 0.6 - travel.travelMinutes * 1.1 - waitMin * 0.85;
        } else {
          stepScore = urgency * 1.15 + sameBuildingBonus + sameZoneBonus - travel.travelMinutes * 2.0 - waitMin * 0.95;
        }

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
      routePrioritySum += scoreSeed(bestNext.slot);

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

    const aggregateScore =
      route.length * 100 +
      routePrioritySum * 15 -
      totalDrive * (strategy === 'MIN_DRIVE' ? 1.5 : 0.6) -
      totalWait * 0.35;

    if (aggregateScore > bestScore) {
      bestScore = aggregateScore;
      bestRoute = route;
    }
  }

  return bestRoute;
}

/**
 * Generates Plans A, B, and C for a single day while honoring every Territory Rx rule.
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
  } = input;

  const targetVisits = Math.max(1, targetOverride ?? settings.dailyHcpTarget ?? 8);
  const isoDay = getIsoDayOfWeek(dateIso);
  const isWeekend = (settings.weekendDaysIso || []).includes(isoDay);
  const { weekStartIso } = getWeekBounds(dateIso, settings.firstDayOfWeekIso);

  // Resolve effective GPS coordinates on the fly for all clinics (supporting both VERIFIED & EXTRACTED_URL)
  const resolvedClinics: Clinic[] = clinics.map((c) => {
    const geo = getEffectiveClinicCoordinates(c);
    if (!geo.resolvedOnTheFly) return c;
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

  // Weekly lock enforcement across ALL clinics of an HCP
  const lockedHcpIds = new Set<string>(extraBlockedHcpIds ? Array.from(extraBlockedHcpIds) : []);
  if (settings.enforceWeeklyHcpVisitLimit !== false) {
    for (const lock of weeklyLocks) {
      if (
        lock.weekStartIso === weekStartIso &&
        lock.plannedDateIso !== dateIso &&
        (lock.status === 'PLANNED' || lock.status === 'COMPLETED' || lock.status === 'CONFIRMED')
      ) {
        lockedHcpIds.add(lock.hcpTargetId);
      }
    }
  }

  const activeHcps = hcps.filter((h) => h.isActive && !h.isDeleted);
  const activeHcpMap = new Map<string, Hcp>(activeHcps.map((h) => [h.targetId, h]));

  const hasShiftBounds =
    typeof shiftStartMinute === 'number' &&
    typeof shiftEndMinute === 'number' &&
    shiftEndMinute > shiftStartMinute;

  const candidates: CandidateClinicSlot[] = [];
  const eligibleUniqueHcps = new Set<string>();

  if (!isWeekend) {
    for (const clinic of resolvedClinics) {
      if (!clinic.isActive) continue;
      const hcp = activeHcpMap.get(clinic.hcpTargetId);
      if (!hcp) continue;
      if (lockedHcpIds.has(hcp.targetId)) continue;

      const effectiveZone = (clinic.zone || hcp.zone || '').trim();
      if (zoneFilter && zoneFilter !== 'ALL' && effectiveZone.toLowerCase() !== zoneFilter.toLowerCase()) {
        continue;
      }

      const effectiveSchedule = getEffectiveClinicWindows(clinic);
      // Do not schedule unconfirmed ambiguous-only schedules if no valid windows exist
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

      const cov = computeHcpQuarterCoverage(
        hcp,
        visits,
        settings.currentQuarterLabel,
        dateIso
      );
      // Exclude doctors once completedVisitsThisQuarter >= hcp.quarterlyTarget
      const targetForHcp = Math.max(1, hcp.quarterlyTarget || 8);
      if (cov.completed >= targetForHcp || cov.remaining <= 0) continue;

      const duration = Math.max(
        5,
        hcp.defaultVisitDurationMinutes || settings.defaultVisitDurationMinutes || 15
      );

      for (const win of dayWindows) {
        const rawBounds = getEffectiveWindowBounds(win);
        const start = hasShiftBounds ? Math.max(rawBounds.start, shiftStartMinute!) : rawBounds.start;
        const end = hasShiftBounds ? Math.min(rawBounds.end, shiftEndMinute!) : rawBounds.end;
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

  return variants.map((v) => {
    const stops = isWeekend ? [] : buildVariantStops(candidates, v.strategy, settings, targetVisits);
    return recomputePlanFromStops({
      userId,
      dateIso,
      variantCode: v.code,
      variantLabel: v.label,
      isSelected: v.isSelected,
      stops,
      clinicsByKey,
      settings,
      targetVisits,
      eligibleUniqueHcpsCount: eligibleUniqueHcps.size,
      weeklyLockedCount: lockedHcpIds.size,
      weekendBlocked: isWeekend,
    });
  });
}

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
      extraBlockedHcpIds: input.settings.enforceWeeklyHcpVisitLimit !== false ? usedInWeek : undefined,
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
