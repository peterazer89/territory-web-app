export type GeocodingStatus = 'VERIFIED' | 'EXTRACTED_URL' | 'UNVERIFIED' | 'MISSING';
export type ScheduleParseStatus = 'CONFIRMED' | 'PARSED_HIGH_CONFIDENCE' | 'AMBIGUOUS' | 'UNPARSED';
export type VisitStatus = 'PLANNED' | 'COMPLETED' | 'CANCELLED' | 'NOT_COMPLETED';
export type WeeklyLockStatus = 'PLANNED' | 'COMPLETED' | 'CONFIRMED';
export type FeasibilityStatus = 'FEASIBLE' | 'PARTIAL_TARGET' | 'INFEASIBLE';
export type ThemeMode = 'SYSTEM' | 'LIGHT' | 'DARK';

export type FirestoreTimestampLike = number | string | { seconds: number; nanoseconds: number } | null;

export interface Hcp {
  id: string; // docId: hcp_{targetId}
  userId: string;
  targetId: string;
  name: string;
  specialty: string;
  quarterlyTarget: number;
  priorityScore: number;
  zone: string;
  isActive: boolean;
  defaultVisitDurationMinutes: number;
  importedBaselineVisits: number;
  baselineQuarterLabel: string;
  historyIncomplete: boolean;
  notes: string;
  sourceWorkbook: string;
  version: number;
  isDeleted: boolean;
  createdAt: FirestoreTimestampLike;
  updatedAt: FirestoreTimestampLike;
}

export interface ClinicWindow {
  dayOfWeek: number; // ISO 1=Mon .. 7=Sun
  startMinuteOfDay: number; // 0..1439
  endMinuteOfDay: number; // 0..1439
  endsNextDay: boolean;
  isConfirmed: boolean;
}

export interface Clinic {
  id: string; // docId: clinic_{hcpTargetId}_C{clinicIndex}
  userId: string;
  clinicKey: string; // "{hcpTargetId}::C{clinicIndex}"
  hcpTargetId: string;
  clinicIndex: number;
  label: string;
  zone: string;
  originalLocationText: string;
  googleMapsUrl: string;
  latitude: number | null;
  longitude: number | null;
  geocodingStatus: GeocodingStatus;
  rawScheduleText: string;
  originalExcelScheduleText: string;
  normalizedDaysCsv: string;
  excludedDaysCsv: string;
  scheduleParseStatus: ScheduleParseStatus;
  scheduleClassification: string;
  parsingMethod: string;
  validationStatus: string;
  userConfirmedSchedule: boolean;
  isManualUserConfirmed: boolean;
  isActive: boolean;
  scheduleAmbiguityReason: string;
  sourceSheet: string;
  sourceRow: number;
  sourceColumn: string;
  windows: ClinicWindow[];
  version: number;
  createdAt: FirestoreTimestampLike;
  updatedAt: FirestoreTimestampLike;
}

export interface Visit {
  id: string; // docId: visit_{hcpTargetId}_{plannedDateIso}
  userId: string;
  hcpTargetId: string;
  clinicKey: string;
  clinicLabel: string;
  plannedDateIso: string; // YYYY-MM-DD
  weekKey: string; // weekStartIso
  plannedStartMinute: number;
  plannedEndMinute: number;
  quarterLabel: string;
  recordSource: string;
  status: VisitStatus;
  qualifiesForCoverage: boolean;
  notes: string;
  version: number;
  createdAt: FirestoreTimestampLike;
  updatedAt: FirestoreTimestampLike;
}

export interface WeeklyLock {
  id: string; // docId: wlock_{weekStartIso}_{hcpTargetId}
  userId: string;
  hcpTargetId: string;
  weekStartIso: string;
  weekEndIso: string;
  visitDocId: string;
  plannedDateIso: string;
  clinicKey: string;
  clinicLabel: string;
  status: WeeklyLockStatus;
  version: number;
  createdAt: FirestoreTimestampLike;
  updatedAt: FirestoreTimestampLike;
}

export interface PlanStop {
  stopOrder: number;
  hcpTargetId: string;
  hcpName: string;
  specialty: string;
  clinicKey: string;
  clinicLabel: string;
  zone: string;
  latitude: number | null;
  longitude: number | null;
  arrivalMinute: number;
  visitStartMinute: number;
  visitEndMinute: number;
  visitDurationMinutes: number;
  travelMinutesFromPrev: number;
  distanceKmFromPrev: number;
  executionStatus: VisitStatus;
  isLocked: boolean;
}

export interface DailyPlan {
  id: string; // docId: plan_{dateIso}_{variantCode}
  userId: string;
  dateIso: string;
  variantCode: string; // "A" | "B" | "C"
  variantLabel: string;
  isSelected: boolean;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  totalDutySpanMinutes: number;
  totalDrivingMinutes: number;
  totalDistanceKm: number;
  totalWaitingMinutes: number;
  plannedVisitsCount: number;
  uniqueHcpsCount: number;
  feasibilityStatus: FeasibilityStatus;
  infeasibilityReasonsText: string;
  validatorReportText: string;
  stops: PlanStop[];
  version: number;
  createdAt: FirestoreTimestampLike;
  updatedAt: FirestoreTimestampLike;
}

export interface WorkSettings {
  userId: string;
  dailyHcpTarget: number;
  maxDutySpanMinutes: number;
  homeAddress: string;
  homeLatitude: number | null;
  homeLongitude: number | null;
  returnHomeRequired: boolean;
  defaultVisitDurationMinutes: number;
  weekendDaysIso: number[]; // ISO 1=Mon..7=Sun
  workingDaysIso: number[];
  firstDayOfWeekIso: number; // ISO 1=Mon..7=Sun
  territoryTimeZoneId: string;
  currentQuarterLabel: string;
  overdueThresholdDays: number;
  trafficSafetyBufferPercent: number;
  priorityWeightSpecialtyPercent: number;
  priorityWeightRemainingVisitsPercent: number;
  priorityWeightTravelDistancePercent: number;
  preferredSpecialtiesRanked: string[];
  availableSpecialtiesCatalog: string[];
  hasUserConfiguredPreferredSpecialties: boolean;
  enforceWeeklyHcpVisitLimit: boolean;
  themeMode: ThemeMode;
  version: number;
  createdAt: FirestoreTimestampLike;
  updatedAt: FirestoreTimestampLike;
}

export type SyncStatusKind = 'SYNCED' | 'SYNCING' | 'PENDING_OFFLINE' | 'OFFLINE' | 'ERROR';

export interface SyncState {
  status: SyncStatusKind;
  hasPendingWrites: boolean;
  fromCache: boolean;
  lastSyncedAt: Date | null;
  errorMessage: string | null;
}

export type AppTab = 'planner' | 'hcps' | 'import' | 'settings';
