import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocsFromServer,
  onSnapshot,
  runTransaction,
  setDoc,
  waitForPendingWrites,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  Clinic,
  DailyPlan,
  Hcp,
  PlanStop,
  Visit,
  VisitStatus,
  WeeklyLock,
  WorkSettings,
} from '../types/territory';
import { getQuarterLabel, getWeekBounds } from './dateUtils';
import { db, handleFirestoreError, OperationType } from './firebase';
import { normalizeClinicWindowsList } from '../utils/availabilityScheduleParser';
import { getEffectiveClinicCoordinates } from '../utils/gpsLocationParser';

export class WeeklyLockConflictError extends Error {
  existingLock: WeeklyLock;
  constructor(lock: WeeklyLock) {
    super(
      `Weekly limit conflict: HCP ${lock.hcpTargetId} already has a ${lock.status.toLowerCase()} visit on ${lock.plannedDateIso} (${lock.clinicLabel || lock.clinicKey}) in week ${lock.weekStartIso} – ${lock.weekEndIso}.`
    );
    this.name = 'WeeklyLockConflictError';
    this.existingLock = lock;
  }
}

export function sanitizeDocId(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\-:.]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || 'unknown').slice(0, 100);
}

export function hcpDocId(targetId: string): string {
  return `hcp_${sanitizeDocId(targetId)}`;
}

export function clinicDocId(hcpTargetId: string, clinicIndex: number): string {
  return `clinic_${sanitizeDocId(hcpTargetId)}_C${clinicIndex}`;
}

export function clinicKeyFor(hcpTargetId: string, clinicIndex: number): string {
  return `${hcpTargetId}::C${clinicIndex}`;
}

export function visitDocId(hcpTargetId: string, plannedDateIso: string): string {
  return `visit_${sanitizeDocId(hcpTargetId)}_${plannedDateIso}`;
}

export function weeklyLockDocId(weekStartIso: string, hcpTargetId: string): string {
  return `wlock_${weekStartIso}_${sanitizeDocId(hcpTargetId)}`;
}

export function planDocId(dateIso: string, variantCode: string): string {
  return `plan_${dateIso}_${sanitizeDocId(variantCode)}`;
}

export function createDefaultWorkSettings(userId: string): WorkSettings {
  const now = Date.now();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo';
  return {
    userId,
    dailyHcpTarget: 8,
    maxDutySpanMinutes: 480,
    homeAddress: '',
    homeLatitude: null,
    homeLongitude: null,
    returnHomeRequired: false,
    defaultVisitDurationMinutes: 15,
    weekendDaysIso: [5],
    workingDaysIso: [1, 2, 3, 4, 6, 7],
    firstDayOfWeekIso: 6,
    territoryTimeZoneId: tz,
    currentQuarterLabel: getQuarterLabel(),
    overdueThresholdDays: 21,
    trafficSafetyBufferPercent: 15,
    priorityWeightSpecialtyPercent: 25,
    priorityWeightRemainingVisitsPercent: 45,
    priorityWeightTravelDistancePercent: 30,
    preferredSpecialtiesRanked: [],
    availableSpecialtiesCatalog: [],
    hasUserConfiguredPreferredSpecialties: false,
    enforceWeeklyHcpVisitLimit: true,
    themeMode: 'SYSTEM',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export interface SnapshotMetaReport {
  hasPendingWrites: boolean;
  fromCache: boolean;
}

function pickFirstNonEmptyString(
  raw: Record<string, unknown>,
  keys: string[]
): string {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.trim();
    }
  }
  return '';
}

function normalizeQuarterlyTargetValue(rawVal: unknown): number {
  const n = Number(rawVal);
  if (Number.isFinite(n) && n >= 1 && n <= 60) {
    return Math.round(n);
  }
  return 8;
}

function normalizeHcpFromFirestore(id: string, raw: Record<string, unknown>): Hcp {
  const targetId =
    pickFirstNonEmptyString(raw, ['targetId', 'hcpTargetId', 'code']) ||
    id.replace(/^hcp_/, '');
  const quarterlyTarget = normalizeQuarterlyTargetValue(
    raw.quarterlyTarget ?? raw.frequencyPerQuarter ?? 8
  );
  return {
    ...(raw as unknown as Hcp),
    id,
    userId: String(raw.userId || ''),
    targetId,
    name: pickFirstNonEmptyString(raw, ['name', 'hcpName', 'doctorName']) || targetId,
    specialty: pickFirstNonEmptyString(raw, ['specialty', 'speciality']) || 'General',
    quarterlyTarget,
    priorityScore: Number.isFinite(Number(raw.priorityScore))
      ? Number(raw.priorityScore)
      : 60,
    zone: pickFirstNonEmptyString(raw, ['zone', 'brick', 'area']),
    isActive: raw.isActive !== false,
    defaultVisitDurationMinutes: Number.isFinite(Number(raw.defaultVisitDurationMinutes))
      ? Number(raw.defaultVisitDurationMinutes)
      : 15,
    importedBaselineVisits: Number.isFinite(Number(raw.importedBaselineVisits))
      ? Number(raw.importedBaselineVisits)
      : 0,
    baselineQuarterLabel: String(raw.baselineQuarterLabel || ''),
    historyIncomplete: Boolean(raw.historyIncomplete),
    notes: String(raw.notes || ''),
    sourceWorkbook: String(raw.sourceWorkbook || ''),
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1,
    isDeleted: Boolean(raw.isDeleted),
    createdAt: (raw.createdAt as Hcp['createdAt']) ?? null,
    updatedAt: (raw.updatedAt as Hcp['updatedAt']) ?? null,
  };
}

function normalizeClinicFromFirestore(id: string, raw: Record<string, unknown>): Clinic {
  // Derive hcpTargetId & clinicIndex from doc fields or fallback to docId `clinic_{targetId}_C{index}`
  const docMatch = id.match(/^clinic_(.+)_C(\d+)$/i);
  const clinicIndexRaw = Number(raw.clinicIndex ?? raw.index ?? docMatch?.[2] ?? 1);
  const clinicIndex = Number.isFinite(clinicIndexRaw) && clinicIndexRaw >= 1 ? Math.round(clinicIndexRaw) : 1;
  const hcpTargetId =
    pickFirstNonEmptyString(raw, ['hcpTargetId', 'targetId', 'hcpId']) ||
    (typeof raw.clinicKey === 'string' && raw.clinicKey.includes('::')
      ? raw.clinicKey.split('::')[0]
      : docMatch?.[1] || '');
  const clinicKey =
    pickFirstNonEmptyString(raw, ['clinicKey']) ||
    (hcpTargetId ? clinicKeyFor(hcpTargetId, clinicIndex) : id);

  const rawScheduleText = pickFirstNonEmptyString(raw, [
    'rawScheduleText',
    'originalExcelScheduleText',
    'scheduleText',
    'visitingTime',
    'visitingHours',
    'workingHours',
    'availabilityText',
    'timeOfVisits',
    'clinicSchedule',
    'rawAvailabilityText',
    'rawTimeText',
    'timeAndLocation',
  ]);
  const originalExcelScheduleText =
    pickFirstNonEmptyString(raw, ['originalExcelScheduleText', 'rawScheduleText']) ||
    rawScheduleText;

  const isConfirmed = Boolean(raw.isManualUserConfirmed || raw.userConfirmedSchedule);
  const rawWindowsSource =
    raw.windows ??
    raw.availabilityWindows ??
    raw.scheduleWindows ??
    raw.timeWindows ??
    raw.visitingWindows ??
    raw.parsedWindows ??
    raw.windowsJson;
  const windows = normalizeClinicWindowsList(rawWindowsSource, isConfirmed);

  const scheduleParseStatus =
    (raw.scheduleParseStatus as Clinic['scheduleParseStatus']) || 'UNPARSED';
  const scheduleAmbiguityReason = String(raw.scheduleAmbiguityReason || '');

  const zone = pickFirstNonEmptyString(raw, ['zone', 'brick', 'area']);
  const originalLocationText = pickFirstNonEmptyString(raw, [
    'originalLocationText',
    'locationText',
    'address',
  ]);
  const rawGoogleMapsUrl = pickFirstNonEmptyString(raw, ['googleMapsUrl', 'mapsUrl', 'mapUrl']);
  const rawLat =
    raw.latitude !== null && raw.latitude !== undefined && Number.isFinite(Number(raw.latitude))
      ? Number(raw.latitude)
      : null;
  const rawLng =
    raw.longitude !== null &&
    raw.longitude !== undefined &&
    Number.isFinite(Number(raw.longitude))
      ? Number(raw.longitude)
      : null;
  const rawGeoStatus = (raw.geocodingStatus as Clinic['geocodingStatus']) || 'MISSING';

  const resolvedGeo = getEffectiveClinicCoordinates({
    clinicKey,
    zone,
    latitude: rawLat,
    longitude: rawLng,
    googleMapsUrl: rawGoogleMapsUrl,
    originalLocationText,
    geocodingStatus: rawGeoStatus,
  });

  return {
    ...(raw as unknown as Clinic),
    id,
    userId: String(raw.userId || ''),
    clinicKey,
    hcpTargetId,
    clinicIndex,
    label: pickFirstNonEmptyString(raw, ['label', 'clinicLabel']) || `Clinic ${clinicIndex}`,
    zone,
    originalLocationText,
    googleMapsUrl: resolvedGeo.googleMapsUrl || rawGoogleMapsUrl,
    latitude: resolvedGeo.latitude,
    longitude: resolvedGeo.longitude,
    geocodingStatus: resolvedGeo.geocodingStatus,
    rawScheduleText,
    originalExcelScheduleText,
    normalizedDaysCsv: String(raw.normalizedDaysCsv || ''),
    excludedDaysCsv: String(raw.excludedDaysCsv || ''),
    scheduleParseStatus,
    scheduleClassification: String(raw.scheduleClassification || ''),
    parsingMethod: String(raw.parsingMethod || ''),
    validationStatus: String(raw.validationStatus || ''),
    userConfirmedSchedule: Boolean(raw.userConfirmedSchedule),
    isManualUserConfirmed: Boolean(raw.isManualUserConfirmed),
    isActive: raw.isActive !== false,
    scheduleAmbiguityReason,
    sourceSheet: String(raw.sourceSheet || ''),
    sourceRow: Number.isFinite(Number(raw.sourceRow)) ? Number(raw.sourceRow) : 0,
    sourceColumn: String(raw.sourceColumn || ''),
    windows,
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1,
    createdAt: (raw.createdAt as Clinic['createdAt']) ?? null,
    updatedAt: (raw.updatedAt as Clinic['updatedAt']) ?? null,
  };
}

export function subscribeUserCollection<T extends { id: string }>(
  userId: string,
  collectionName: 'hcps' | 'clinics' | 'visits' | 'weeklyLocks' | 'plans',
  onData: (items: T[], meta: SnapshotMetaReport) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = `users/${userId}/${collectionName}`;
  const ref = collection(db, 'users', userId, collectionName);
  return onSnapshot(
    ref,
    { includeMetadataChanges: true },
    (snap) => {
      const items = snap.docs.map((d) => {
        const raw = d.data() as Record<string, unknown>;
        if (collectionName === 'hcps') {
          return normalizeHcpFromFirestore(d.id, raw) as unknown as T;
        }
        if (collectionName === 'clinics') {
          return normalizeClinicFromFirestore(d.id, raw) as unknown as T;
        }
        return {
          ...(raw as Omit<T, 'id'>),
          id: d.id,
        } as T;
      });
      onData(items, {
        hasPendingWrites: snap.metadata.hasPendingWrites,
        fromCache: snap.metadata.fromCache,
      });
    },
    (err) => {
      if (onError) {
        onError(err);
      }
      try {
        handleFirestoreError(err, OperationType.LIST, path);
      } catch {
        // Logged via handleFirestoreError; surfaced to caller via onError
      }
    }
  );
}

export function subscribeWorkSettings(
  userId: string,
  onData: (settings: WorkSettings, existsInCloud: boolean, meta: SnapshotMetaReport) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const path = `users/${userId}/settings/work`;
  const ref = doc(db, 'users', userId, 'settings', 'work');
  return onSnapshot(
    ref,
    { includeMetadataChanges: true },
    (snap) => {
      const defaults = createDefaultWorkSettings(userId);
      if (snap.exists()) {
        const raw = snap.data() as Partial<WorkSettings>;
        onData(
          {
            ...defaults,
            ...raw,
            userId,
          },
          true,
          {
            hasPendingWrites: snap.metadata.hasPendingWrites,
            fromCache: snap.metadata.fromCache,
          }
        );
      } else {
        onData(defaults, false, {
          hasPendingWrites: snap.metadata.hasPendingWrites,
          fromCache: snap.metadata.fromCache,
        });
      }
    },
    (err) => {
      if (onError) onError(err);
      try {
        handleFirestoreError(err, OperationType.GET, path);
      } catch {
        // Logged via handleFirestoreError
      }
    }
  );
}

export async function saveWorkSettings(userId: string, settings: WorkSettings): Promise<void> {
  const path = `users/${userId}/settings/work`;
  const now = Date.now();
  const wSpec = Number(settings.priorityWeightSpecialtyPercent ?? 25);
  const wRem = Number(settings.priorityWeightRemainingVisitsPercent ?? 45);
  const wDist = Math.max(0, 100 - wSpec - wRem);
  const payload = stripUndefined({
    userId,
    dailyHcpTarget: settings.dailyHcpTarget,
    maxDutySpanMinutes: settings.maxDutySpanMinutes,
    homeAddress: (settings.homeAddress || '').slice(0, 500),
    homeLatitude: settings.homeLatitude ?? null,
    homeLongitude: settings.homeLongitude ?? null,
    returnHomeRequired: Boolean(settings.returnHomeRequired),
    defaultVisitDurationMinutes: settings.defaultVisitDurationMinutes,
    weekendDaysIso: settings.weekendDaysIso,
    workingDaysIso: settings.workingDaysIso,
    firstDayOfWeekIso: settings.firstDayOfWeekIso,
    territoryTimeZoneId: (settings.territoryTimeZoneId || 'Africa/Cairo').slice(0, 64),
    currentQuarterLabel: (settings.currentQuarterLabel || getQuarterLabel()).slice(0, 32),
    overdueThresholdDays: settings.overdueThresholdDays,
    trafficSafetyBufferPercent: settings.trafficSafetyBufferPercent,
    priorityWeightSpecialtyPercent: wSpec,
    priorityWeightRemainingVisitsPercent: wRem,
    priorityWeightTravelDistancePercent: wDist,
    preferredSpecialtiesRanked: (settings.preferredSpecialtiesRanked || []).slice(0, 100),
    availableSpecialtiesCatalog: (settings.availableSpecialtiesCatalog || []).slice(0, 200),
    hasUserConfiguredPreferredSpecialties: Boolean(settings.hasUserConfiguredPreferredSpecialties),
    enforceWeeklyHcpVisitLimit: settings.enforceWeeklyHcpVisitLimit !== false,
    themeMode: settings.themeMode || 'SYSTEM',
    version: (settings.version || 0) + 1,
    createdAt: settings.createdAt ?? now,
    updatedAt: now,
  });
  try {
    await setDoc(doc(db, 'users', userId, 'settings', 'work'), payload, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveHcp(userId: string, hcp: Omit<Hcp, 'id'>): Promise<string> {
  const docId = hcpDocId(hcp.targetId);
  const path = `users/${userId}/hcps/${docId}`;
  const now = Date.now();
  const payload = stripUndefined({
    userId,
    targetId: hcp.targetId.trim().slice(0, 128),
    name: hcp.name.trim().slice(0, 200),
    specialty: (hcp.specialty || '').trim().slice(0, 120),
    quarterlyTarget: normalizeQuarterlyTargetValue(hcp.quarterlyTarget),
    priorityScore: hcp.priorityScore,
    zone: (hcp.zone || '').trim().slice(0, 120),
    isActive: hcp.isActive,
    defaultVisitDurationMinutes: hcp.defaultVisitDurationMinutes,
    importedBaselineVisits: hcp.importedBaselineVisits,
    baselineQuarterLabel: (hcp.baselineQuarterLabel || '').slice(0, 32),
    historyIncomplete: Boolean(hcp.historyIncomplete),
    notes: (hcp.notes || '').slice(0, 2000),
    sourceWorkbook: (hcp.sourceWorkbook || '').slice(0, 255),
    version: (hcp.version || 0) + 1,
    isDeleted: Boolean(hcp.isDeleted),
    createdAt: hcp.createdAt ?? now,
    updatedAt: now,
  });
  try {
    await setDoc(doc(db, 'users', userId, 'hcps', docId), payload, { merge: true });
    return docId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveClinic(userId: string, clinic: Omit<Clinic, 'id'>): Promise<string> {
  const docId = clinicDocId(clinic.hcpTargetId, clinic.clinicIndex);
  const path = `users/${userId}/clinics/${docId}`;
  const now = Date.now();
  const payload = stripUndefined({
    userId,
    clinicKey: clinic.clinicKey || clinicKeyFor(clinic.hcpTargetId, clinic.clinicIndex),
    hcpTargetId: clinic.hcpTargetId.trim().slice(0, 128),
    clinicIndex: clinic.clinicIndex,
    label: (clinic.label || `Clinic ${clinic.clinicIndex}`).slice(0, 120),
    zone: (clinic.zone || '').slice(0, 120),
    originalLocationText: (clinic.originalLocationText || '').slice(0, 500),
    googleMapsUrl: (clinic.googleMapsUrl || '').slice(0, 1000),
    latitude: clinic.latitude ?? null,
    longitude: clinic.longitude ?? null,
    geocodingStatus: clinic.geocodingStatus || 'MISSING',
    rawScheduleText: (clinic.rawScheduleText || '').slice(0, 500),
    originalExcelScheduleText: (clinic.originalExcelScheduleText || '').slice(0, 500),
    normalizedDaysCsv: (clinic.normalizedDaysCsv || '').slice(0, 64),
    excludedDaysCsv: (clinic.excludedDaysCsv || '').slice(0, 64),
    scheduleParseStatus: clinic.scheduleParseStatus || 'UNPARSED',
    scheduleClassification: (clinic.scheduleClassification || '').slice(0, 64),
    parsingMethod: (clinic.parsingMethod || '').slice(0, 64),
    validationStatus: (clinic.validationStatus || '').slice(0, 64),
    userConfirmedSchedule: Boolean(clinic.userConfirmedSchedule),
    isManualUserConfirmed: Boolean(clinic.isManualUserConfirmed),
    isActive: clinic.isActive !== false,
    scheduleAmbiguityReason: (clinic.scheduleAmbiguityReason || '').slice(0, 500),
    sourceSheet: (clinic.sourceSheet || '').slice(0, 120),
    sourceRow: clinic.sourceRow ?? 0,
    sourceColumn: (clinic.sourceColumn || '').slice(0, 64),
    windows: (clinic.windows || []).slice(0, 42),
    version: (clinic.version || 0) + 1,
    createdAt: clinic.createdAt ?? now,
    updatedAt: now,
  });
  try {
    await setDoc(doc(db, 'users', userId, 'clinics', docId), payload, { merge: true });
    return docId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteClinicDoc(userId: string, clinicId: string): Promise<void> {
  const path = `users/${userId}/clinics/${clinicId}`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'clinics', clinicId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function batchDeleteHcpsAndClinics(
  userId: string,
  hcpIds: string[],
  clinicIds: string[]
): Promise<void> {
  const path = `users/${userId}/hcps`;
  const refs = [
    ...hcpIds.map((id) => doc(db, 'users', userId, 'hcps', id)),
    ...clinicIds.map((id) => doc(db, 'users', userId, 'clinics', id)),
  ];
  try {
    const CHUNK = 350;
    for (let i = 0; i < refs.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const ref of refs.slice(i, i + CHUNK)) {
        batch.delete(ref);
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

function safeFiniteNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildSafePlanPayload(
  userId: string,
  plan: Omit<DailyPlan, 'id'>,
  now: number
): Record<string, unknown> {
  const allowedStatus =
    plan.feasibilityStatus === 'FEASIBLE' ||
    plan.feasibilityStatus === 'PARTIAL_TARGET' ||
    plan.feasibilityStatus === 'INFEASIBLE'
      ? plan.feasibilityStatus
      : 'PARTIAL_TARGET';

  const safeStops = (plan.stops || []).slice(0, 40).map((s) =>
    stripUndefined({
      stopOrder: safeFiniteNum(s.stopOrder, 0),
      hcpTargetId: String(s.hcpTargetId || '').slice(0, 128),
      hcpName: String(s.hcpName || '').slice(0, 200),
      specialty: String(s.specialty || '').slice(0, 120),
      clinicKey: String(s.clinicKey || '').slice(0, 160),
      clinicLabel: String(s.clinicLabel || '').slice(0, 120),
      zone: String(s.zone || '').slice(0, 120),
      latitude:
        s.latitude !== null && s.latitude !== undefined && Number.isFinite(Number(s.latitude))
          ? Number(s.latitude)
          : null,
      longitude:
        s.longitude !== null && s.longitude !== undefined && Number.isFinite(Number(s.longitude))
          ? Number(s.longitude)
          : null,
      arrivalMinute: safeFiniteNum(s.arrivalMinute, 0),
      visitStartMinute: safeFiniteNum(s.visitStartMinute, 0),
      visitEndMinute: safeFiniteNum(s.visitEndMinute, 0),
      visitDurationMinutes: safeFiniteNum(s.visitDurationMinutes, 15),
      travelMinutesFromPrev: safeFiniteNum(s.travelMinutesFromPrev, 0),
      distanceKmFromPrev: safeFiniteNum(s.distanceKmFromPrev, 0),
      executionStatus: s.executionStatus || 'PLANNED',
      isLocked: Boolean(s.isLocked),
    })
  );

  return stripUndefined({
    userId,
    dateIso: String(plan.dateIso || '').trim().slice(0, 32),
    variantCode: String(plan.variantCode || 'A').trim().slice(0, 16),
    variantLabel: String(plan.variantLabel || '').slice(0, 120),
    isSelected: Boolean(plan.isSelected),
    startMinuteOfDay: safeFiniteNum(plan.startMinuteOfDay, 0),
    endMinuteOfDay: safeFiniteNum(plan.endMinuteOfDay, 0),
    totalDutySpanMinutes: safeFiniteNum(plan.totalDutySpanMinutes, 0),
    totalDrivingMinutes: safeFiniteNum(plan.totalDrivingMinutes, 0),
    totalDistanceKm: safeFiniteNum(plan.totalDistanceKm, 0),
    totalWaitingMinutes: safeFiniteNum(plan.totalWaitingMinutes, 0),
    plannedVisitsCount: safeFiniteNum(plan.plannedVisitsCount, safeStops.length),
    uniqueHcpsCount: safeFiniteNum(plan.uniqueHcpsCount, safeStops.length),
    feasibilityStatus: allowedStatus,
    infeasibilityReasonsText: String(plan.infeasibilityReasonsText || '').slice(0, 2000),
    validatorReportText: String(plan.validatorReportText || '').slice(0, 4000),
    stops: safeStops,
    version: safeFiniteNum(plan.version, 0) + 1,
    createdAt: plan.createdAt ?? now,
    updatedAt: now,
  });
}

export async function saveDailyPlan(userId: string, plan: Omit<DailyPlan, 'id'>): Promise<string> {
  const docId = planDocId(plan.dateIso, plan.variantCode);
  const path = `users/${userId}/plans/${docId}`;
  const now = Date.now();
  const payload = buildSafePlanPayload(userId, plan, now);
  try {
    await setDoc(doc(db, 'users', userId, 'plans', docId), payload, { merge: true });
    return docId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveDailyPlanBatch(
  userId: string,
  plans: Array<Omit<DailyPlan, 'id'>>
): Promise<void> {
  const path = `users/${userId}/plans`;
  const now = Date.now();
  try {
    const CHUNK = 350;
    for (let i = 0; i < plans.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const plan of plans.slice(i, i + CHUNK)) {
        const docId = planDocId(plan.dateIso, plan.variantCode);
        const ref = doc(db, 'users', userId, 'plans', docId);
        batch.set(ref, buildSafePlanPayload(userId, plan, now), { merge: true });
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * Deletes/replaces any previous draft plans for `dateIso` in `/users/{uid}/plans/...`
 * and writes the newly generated Plan A/B/C documents (with Plan A auto-selected).
 */
export async function replaceDailyPlansForDate(
  userId: string,
  dateIso: string,
  existingPlanIdsForDate: string[],
  newPlans: Array<Omit<DailyPlan, 'id'>>
): Promise<void> {
  const path = `users/${userId}/plans`;
  const now = Date.now();
  try {
    const batch = writeBatch(db);
    const newDocIds = new Set(
      newPlans.map((plan) => planDocId(plan.dateIso || dateIso, plan.variantCode))
    );

    // Delete any existing plan documents for this date before writing the fresh plans
    for (const oldId of existingPlanIdsForDate) {
      if (!oldId) continue;
      const oldRef = doc(db, 'users', userId, 'plans', oldId);
      if (!newDocIds.has(oldId)) {
        batch.delete(oldRef);
      } else {
        batch.delete(oldRef);
      }
    }

    for (const plan of newPlans) {
      const docId = planDocId(plan.dateIso || dateIso, plan.variantCode);
      const ref = doc(db, 'users', userId, 'plans', docId);
      batch.set(
        ref,
        buildSafePlanPayload(
          userId,
          {
            ...plan,
            dateIso: plan.dateIso || dateIso,
            isSelected: plan.variantCode === 'A',
          },
          now
        )
      );
    }

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * Atomically schedules or updates a visit and enforces the once-per-HCP-per-calendar-week
 * weeklyLocks invariant across ALL clinics using a Firestore transaction.
 */
export async function upsertVisitWithWeeklyLockTx(
  userId: string,
  params: {
    hcpTargetId: string;
    clinicKey: string;
    clinicLabel: string;
    plannedDateIso: string;
    plannedStartMinute: number;
    plannedEndMinute: number;
    status: VisitStatus;
    quarterLabel: string;
    firstDayOfWeekIso: number;
    enforceWeeklyLimit: boolean;
    notes?: string;
    recordSource?: string;
  }
): Promise<{ visitId: string; lockId: string }> {
  const { weekStartIso, weekEndIso, weekKey } = getWeekBounds(
    params.plannedDateIso,
    params.firstDayOfWeekIso
  );
  const vDocId = visitDocId(params.hcpTargetId, params.plannedDateIso);
  const lDocId = weeklyLockDocId(weekStartIso, params.hcpTargetId);
  const visitRef = doc(db, 'users', userId, 'visits', vDocId);
  const lockRef = doc(db, 'users', userId, 'weeklyLocks', lDocId);
  const path = `users/${userId}/visits/${vDocId}`;

  const isActiveOrCompleted = params.status === 'PLANNED' || params.status === 'COMPLETED';
  const now = Date.now();

  try {
    await runTransaction(db, async (tx) => {
      const [existingLockSnap, existingVisitSnap] = await Promise.all([
        tx.get(lockRef),
        tx.get(visitRef),
      ]);

      if (isActiveOrCompleted && params.enforceWeeklyLimit && existingLockSnap.exists()) {
        const lockData = {
          ...(existingLockSnap.data() as Omit<WeeklyLock, 'id'>),
          id: existingLockSnap.id,
        };
        const activeLockStatus =
          lockData.status === 'PLANNED' ||
          lockData.status === 'COMPLETED' ||
          lockData.status === 'CONFIRMED';

        if (activeLockStatus && lockData.visitDocId !== vDocId) {
          throw new WeeklyLockConflictError(lockData);
        }
      }

      const prevVisit = existingVisitSnap.exists()
        ? (existingVisitSnap.data() as Partial<Visit>)
        : null;

      const visitPayload = stripUndefined({
        userId,
        hcpTargetId: params.hcpTargetId.trim().slice(0, 128),
        clinicKey: (params.clinicKey || '').slice(0, 160),
        clinicLabel: (params.clinicLabel || '').slice(0, 120),
        plannedDateIso: params.plannedDateIso.trim().slice(0, 32),
        weekKey: weekKey.slice(0, 32),
        plannedStartMinute: safeFiniteNum(params.plannedStartMinute, 0),
        plannedEndMinute: safeFiniteNum(params.plannedEndMinute, 0),
        quarterLabel: (params.quarterLabel || getQuarterLabel(params.plannedDateIso)).slice(0, 32),
        recordSource: (params.recordSource || prevVisit?.recordSource || 'PLANNER_WEB').slice(0, 64),
        status: params.status,
        qualifiesForCoverage: params.status === 'COMPLETED',
        notes: (params.notes ?? prevVisit?.notes ?? '').slice(0, 1000),
        version: safeFiniteNum(prevVisit?.version, 0) + 1,
        createdAt: prevVisit?.createdAt ?? now,
        updatedAt: now,
      });

      tx.set(visitRef, visitPayload, { merge: true });

      if (isActiveOrCompleted) {
        const prevLock = existingLockSnap.exists()
          ? (existingLockSnap.data() as Partial<WeeklyLock>)
          : null;
        const lockPayload = stripUndefined({
          userId,
          hcpTargetId: params.hcpTargetId.trim().slice(0, 128),
          weekStartIso: weekStartIso.slice(0, 32),
          weekEndIso: weekEndIso.slice(0, 32),
          visitDocId: vDocId.slice(0, 160),
          plannedDateIso: params.plannedDateIso.trim().slice(0, 32),
          clinicKey: (params.clinicKey || '').slice(0, 160),
          clinicLabel: (params.clinicLabel || '').slice(0, 120),
          status: params.status === 'COMPLETED' ? 'COMPLETED' : 'PLANNED',
          version: safeFiniteNum(prevLock?.version, 0) + 1,
          createdAt: prevLock?.createdAt ?? now,
          updatedAt: now,
        });
        tx.set(lockRef, lockPayload, { merge: true });
      } else if (existingLockSnap.exists()) {
        const lockData = existingLockSnap.data() as Partial<WeeklyLock>;
        if (lockData.visitDocId === vDocId) {
          tx.delete(lockRef);
        }
      }
    });

    return { visitId: vDocId, lockId: lDocId };
  } catch (error) {
    if (error instanceof WeeklyLockConflictError) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * Commits all stops of a selected daily plan to visits & weeklyLocks via transactions,
 * returning committed stops and any weekly-lock conflicts cleanly.
 */
export async function commitPlanStopsWithLocks(
  userId: string,
  plan: DailyPlan,
  settings: WorkSettings
): Promise<{
  committedCount: number;
  conflicts: Array<{ stop: PlanStop; reason: string }>;
}> {
  let committedCount = 0;
  const conflicts: Array<{ stop: PlanStop; reason: string }> = [];

  for (const stop of plan.stops) {
    try {
      await upsertVisitWithWeeklyLockTx(userId, {
        hcpTargetId: stop.hcpTargetId,
        clinicKey: stop.clinicKey,
        clinicLabel: stop.clinicLabel,
        plannedDateIso: plan.dateIso,
        plannedStartMinute: stop.visitStartMinute,
        plannedEndMinute: stop.visitEndMinute,
        status: stop.executionStatus || 'PLANNED',
        quarterLabel: settings.currentQuarterLabel || getQuarterLabel(plan.dateIso),
        firstDayOfWeekIso: settings.firstDayOfWeekIso,
        enforceWeeklyLimit: settings.enforceWeeklyHcpVisitLimit,
        recordSource: 'PLANNER_WEB',
      });
      committedCount++;
    } catch (err) {
      if (err instanceof WeeklyLockConflictError) {
        conflicts.push({ stop, reason: err.message });
      } else {
        throw err;
      }
    }
  }

  return { committedCount, conflicts };
}

/**
 * Batch imports parsed HCPs and Clinics in chunks of 400 writes (under Firestore 500 write/batch limit).
 */
export async function batchImportTerritoryData(
  userId: string,
  hcpsToWrite: Array<Omit<Hcp, 'id'>>,
  clinicsToWrite: Array<Omit<Clinic, 'id'>>,
  onProgress?: (written: number, total: number) => void
): Promise<void> {
  const total = hcpsToWrite.length + clinicsToWrite.length;
  let written = 0;
  const now = Date.now();
  const path = `users/${userId}/hcps`;

  const ops: Array<{ ref: ReturnType<typeof doc>; data: Record<string, unknown> }> = [];

  for (const h of hcpsToWrite) {
    const id = hcpDocId(h.targetId);
    ops.push({
      ref: doc(db, 'users', userId, 'hcps', id),
      data: stripUndefined({
        userId,
        targetId: h.targetId.trim().slice(0, 128),
        name: h.name.trim().slice(0, 200),
        specialty: (h.specialty || '').trim().slice(0, 120),
        quarterlyTarget: normalizeQuarterlyTargetValue(h.quarterlyTarget),
        priorityScore: h.priorityScore,
        zone: (h.zone || '').trim().slice(0, 120),
        isActive: h.isActive !== false,
        defaultVisitDurationMinutes: h.defaultVisitDurationMinutes,
        importedBaselineVisits: h.importedBaselineVisits,
        baselineQuarterLabel: (h.baselineQuarterLabel || '').slice(0, 32),
        historyIncomplete: Boolean(h.historyIncomplete),
        notes: (h.notes || '').slice(0, 2000),
        sourceWorkbook: (h.sourceWorkbook || '').slice(0, 255),
        version: (h.version || 0) + 1,
        isDeleted: Boolean(h.isDeleted),
        createdAt: h.createdAt ?? now,
        updatedAt: now,
      }),
    });
  }

  for (const c of clinicsToWrite) {
    const id = clinicDocId(c.hcpTargetId, c.clinicIndex);
    ops.push({
      ref: doc(db, 'users', userId, 'clinics', id),
      data: stripUndefined({
        userId,
        clinicKey: c.clinicKey || clinicKeyFor(c.hcpTargetId, c.clinicIndex),
        hcpTargetId: c.hcpTargetId.trim().slice(0, 128),
        clinicIndex: c.clinicIndex,
        label: (c.label || `Clinic ${c.clinicIndex}`).slice(0, 120),
        zone: (c.zone || '').slice(0, 120),
        originalLocationText: (c.originalLocationText || '').slice(0, 500),
        googleMapsUrl: (c.googleMapsUrl || '').slice(0, 1000),
        latitude: c.latitude ?? null,
        longitude: c.longitude ?? null,
        geocodingStatus: c.geocodingStatus || 'MISSING',
        rawScheduleText: (c.rawScheduleText || '').slice(0, 500),
        originalExcelScheduleText: (c.originalExcelScheduleText || '').slice(0, 500),
        normalizedDaysCsv: (c.normalizedDaysCsv || '').slice(0, 64),
        excludedDaysCsv: (c.excludedDaysCsv || '').slice(0, 64),
        scheduleParseStatus: c.scheduleParseStatus || 'UNPARSED',
        scheduleClassification: (c.scheduleClassification || '').slice(0, 64),
        parsingMethod: (c.parsingMethod || '').slice(0, 64),
        validationStatus: (c.validationStatus || '').slice(0, 64),
        userConfirmedSchedule: Boolean(c.userConfirmedSchedule),
        isManualUserConfirmed: Boolean(c.isManualUserConfirmed),
        isActive: c.isActive !== false,
        scheduleAmbiguityReason: (c.scheduleAmbiguityReason || '').slice(0, 500),
        sourceSheet: (c.sourceSheet || '').slice(0, 120),
        sourceRow: c.sourceRow ?? 0,
        sourceColumn: (c.sourceColumn || '').slice(0, 64),
        windows: (c.windows || []).slice(0, 42),
        version: (c.version || 0) + 1,
        createdAt: c.createdAt ?? now,
        updatedAt: now,
      }),
    });
  }

  try {
    const CHUNK = 350;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const slice = ops.slice(i, i + CHUNK);
      const batch = writeBatch(db);
      for (const op of slice) {
        batch.set(op.ref, op.data, { merge: true });
      }
      await batch.commit();
      written += slice.length;
      onProgress?.(written, total);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * Forces pending offline writes to flush and fetches fresh server snapshots across all 6 collections.
 */
export async function forceCloudSync(userId: string): Promise<{ syncedAt: Date; counts: Record<string, number> }> {
  await waitForPendingWrites(db);
  const [hcps, clinics, visits, locks, plans, settingsDoc] = await Promise.all([
    getDocsFromServer(collection(db, 'users', userId, 'hcps')),
    getDocsFromServer(collection(db, 'users', userId, 'clinics')),
    getDocsFromServer(collection(db, 'users', userId, 'visits')),
    getDocsFromServer(collection(db, 'users', userId, 'weeklyLocks')),
    getDocsFromServer(collection(db, 'users', userId, 'plans')),
    getDocFromServer(doc(db, 'users', userId, 'settings', 'work')),
  ]);

  return {
    syncedAt: new Date(),
    counts: {
      hcps: hcps.size,
      clinics: clinics.size,
      visits: visits.size,
      weeklyLocks: locks.size,
      plans: plans.size,
      settings: settingsDoc.exists() ? 1 : 0,
    },
  };
}
