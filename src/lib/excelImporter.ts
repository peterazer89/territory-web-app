import * as XLSX from 'xlsx';
import { Clinic, Hcp } from '../types/territory';
import { getQuarterLabel } from './dateUtils';
import {
  extractCoordinates,
  splitLocationReferences,
} from '../utils/gpsLocationParser';
import {
  classifyScheduleResult,
  looksLikeEmbeddedScheduleText,
  parseSchedule,
} from '../utils/availabilityScheduleParser';
import { clinicKeyFor } from './firestoreService';

export interface ColumnMapping {
  targetId: string;
  hcpName: string;
  specialty: string;
  zone1: string;
  zone2: string;
  locationGps1: string;
  locationGps2: string;
  schedule1: string;
  schedule2: string;
  days1?: string;
  days2?: string;
  quarterlyTarget: string;
  baselineVisits: string;
  notes: string;
}

export interface ParsedWorkbookSheet {
  sheetNames: string[];
  selectedSheet: string;
  headers: string[];
  rows: Record<string, unknown>[];
  detectedMapping: ColumnMapping;
}

export interface QuarterlyTargetParseResult {
  value: number;
  defaultedToEight: boolean;
  multipliedMonthly: boolean;
  warning: string | null;
  note: string | null;
  rawText: string;
}

export interface ImportPreviewRow {
  rowNumber: number;
  hcp: Omit<Hcp, 'id'>;
  clinics: Array<Omit<Clinic, 'id'>>;
  isNewHcp: boolean;
  protectedScheduleCount: number;
  protectedGpsCount: number;
  quarterlyTargetDefaulted: boolean;
  quarterlyTargetMonthlyMultiplied: boolean;
  quarterlyTargetNote: string | null;
  rawQuarterlyTargetText: string;
  warnings: string[];
}

export interface ImportPreviewSummary {
  rows: ImportPreviewRow[];
  totalHcps: number;
  newHcps: number;
  updatedHcps: number;
  totalClinics: number;
  totalQuarterlyTarget: number;
  defaultedQuarterlyTargetCount: number;
  monthlyMultipliedCount: number;
  highConfidenceSchedules: number;
  ambiguousSchedules: number;
  protectedSchedulesPreserved: number;
  protectedGpsPreserved: number;
}

/**
 * Normalizes spreadsheet column headers:
 * - Strips NBSP and invisible zero-width/RTL markers
 * - Lowercases
 * - Collapses [_\-\s()/#.]+ to a single space
 */
export function normalizeHeader(raw: string): string {
  return String(raw || '')
    .replace(/[\u00A0\u200B-\u200F\u202A-\u202E\uFEFF]/g, ' ')
    .toLowerCase()
    .replace(/[_\-\s()/#.]+/g, ' ')
    .trim();
}

const CLINIC_1_SCHEDULE_SYNONYMS: string[] = [
  'visiting time in clinic 1',
  'clinic 1 visiting time',
  'clinic 1 schedule',
  'visiting_time_in_clinic_1',
  'visiting time clinic 1',
  'visiting time in clinic1',
  'visting time in clinic 1',
  'visiting times in clinic 1',
  'clinic 1 visiting hours',
  'clinic 1 working hours',
  'clinic 1 time',
  'clinic1 schedule',
  'clinic1 time',
  'clinic 1 hours',
  'schedule 1',
  'visiting time 1',
  'time 1',
  'visiting time',
  'visiting times',
  'visiting hours',
  'time of visits',
  'time of visit',
  'times of visits',
  'times of visit',
  'visit time',
  'visit times',
  'visits time',
  'visits times',
  'visit hours',
  'visits hours',
  'time of visits 1',
  'time of visit 1',
  'time of visits clinic 1',
  'time of visits in clinic 1',
  'time of visits in clinic1',
  'time of visit in clinic 1',
  'clinic 1 time of visits',
  'clinic 1 time of visit',
  'clinic1 time of visits',
  'clinic 1 visit time',
  'clinic 1 visits time',
  'clinic 1 timing',
  'clinic timing',
  'timing 1',
  'timing',
  'working hours',
  'working time',
  'work hours',
  'clinic hours',
  'schedule',
  'time and location',
  'time & location',
  'location and time',
  'time',
  'availability',
  'clinic availability',
  'schedule and location',
  'visiting time and location',
  'مواعيد عيادة 1',
  'مواعيد عياده 1',
  'مواعيد العيادة 1',
  'مواعيد العياده 1',
  'مواعيد الزيارة',
  'مواعيد الزياره',
  'مواعيد الزيارات',
  'المواعيد',
  'مواعيد',
  'مواعيد 1',
  'وقت الزيارة',
  'وقت الزياره',
  'وقت الزيارات',
  'اوقات الزيارة',
  'أوقات الزيارة',
  'اوقات الزيارات',
  'أوقات الزيارات',
  'مواعيد العمل',
  'ساعات العمل',
  'مواعيد العيادة',
  'مواعيد العياده',
].map(normalizeHeader);

const CLINIC_2_SCHEDULE_SYNONYMS: string[] = [
  'visiting time in clinic 2',
  'clinic 2 visiting time',
  'clinic 2 schedule',
  'visiting_time_in_clinic_2',
  'visiting time clinic 2',
  'visiting time in clinic2',
  'visting time in clinic 2',
  'visiting times in clinic 2',
  'clinic 2 visiting hours',
  'clinic 2 working hours',
  'clinic2 schedule',
  'clinic2 visiting time',
  'clinic2 time',
  'clinic 2 hours',
  'schedule 2',
  'visiting time 2',
  'time 2',
  'clinic 2 time',
  'time of visits 2',
  'time of visit 2',
  'time of visits clinic 2',
  'time of visits in clinic 2',
  'time of visits in clinic2',
  'time of visit in clinic 2',
  'clinic 2 time of visits',
  'clinic 2 time of visit',
  'clinic2 time of visits',
  'clinic 2 visit time',
  'clinic 2 visits time',
  'clinic 2 timing',
  'timing 2',
  'second clinic visiting time',
  'second clinic time of visits',
  'second clinic schedule',
  'second clinic hours',
  'second clinic time',
  'مواعيد عيادة 2',
  'مواعيد عياده 2',
  'مواعيد العيادة 2',
  'مواعيد العياده 2',
  'مواعيد 2',
  'مواعيد العيادة الثانية',
  'مواعيد العياده الثانيه',
  'وقت الزيارة عيادة 2',
  'وقت الزيارة 2',
  'وقت الزيارات 2',
  'وقت الزيارات عيادة 2',
  'مواعيد الزيارات 2',
].map(normalizeHeader);

function isClinic2Header(norm: string): boolean {
  return /(?:^|\s)(?:2|clinic2|second|2nd)(?:\s|$)|عيادة\s*2|عياده\s*2|الثانية|الثانيه|ثاني/.test(norm);
}

function isClinic1Header(norm: string): boolean {
  return /(?:^|\s)(?:1|clinic1|first|1st)(?:\s|$)|عيادة\s*1|عياده\s*1|الأولى|الاولى|اول/.test(norm);
}

function matchScheduleColumn(
  headers: string[],
  synonyms: string[],
  clinicNum: 1 | 2,
  excludeHeader?: string
): string {
  const normalizedPairs = headers
    .filter((h) => h !== excludeHeader)
    .map((h) => ({ raw: h, norm: normalizeHeader(h) }));

  // 1. Exact synonym match first
  for (const syn of synonyms) {
    const exact = normalizedPairs.find((p) => p.norm === syn);
    if (exact) return exact.raw;
  }

  // 2. Fuzzy fallback with strict Clinic 1 vs Clinic 2 guard
  // IMPORTANT: Do NOT exclude the word "visits" itself because columns like "Time of Visits" contain it!
  const scheduleKeyword =
    /(?:visiting|visting|schedule|hours|time|timing|availability|shift|appointment|مواعيد|وقت|اوقات|أوقات|ساعات)/i;
  const excludeNonSchedule =
    /(?:gps|lat|lng|long|map|zone|brick|area|quarterly\s*target|qtr\s*target|target\s*visits?|baseline\s*visits?|completed\s*visits?|actual\s*visits?|prior\s*visits?|visit\s*count|visits?\s*count|number\s*of\s*visits|frequency|\btarget\b|\bid\b|\bname\b|specialt|specialit)/i;

  for (const p of normalizedPairs) {
    if (!scheduleKeyword.test(p.norm)) continue;
    if (
      excludeNonSchedule.test(p.norm) &&
      !/time\s*(?:and|&)\s*location|location\s*(?:and|&)\s*time|schedule\s*(?:and|&)\s*location/.test(
        p.norm
      )
    ) {
      continue;
    }
    if (clinicNum === 2) {
      if (isClinic2Header(p.norm) && !isClinic1Header(p.norm)) {
        return p.raw;
      }
    } else {
      if (!isClinic2Header(p.norm)) {
        return p.raw;
      }
    }
  }

  return '';
}

const CLINIC_1_LOCATION_SYNONYMS: string[] = [
  'location gps',
  'gps location',
  'clinic location',
  'clinic gps',
  'clinic 1 gps location',
  'clinic 1 location',
  'clinic1 location',
  'clinic 1 gps',
  'clinic_1_gps_location',
  'clinic 1 map',
  'clinic 1 map link',
  'gps 1',
  'location 1',
  'clinic 1 address',
  'address 1',
  'address',
  'location',
  'gps',
  'map link',
  'google maps',
  'google maps 1',
  'maps 1',
  'maps',
  'coordinates',
  'coordinate',
  'عنوان عيادة 1',
  'عنوان عياده 1',
  'لوكيشن عيادة 1',
  'لوكيشن عياده 1',
  'العنوان',
  'اللوكيشن',
  'موقع عيادة 1',
  'موقع عياده 1',
].map(normalizeHeader);

const CLINIC_2_LOCATION_SYNONYMS: string[] = [
  'clinic 2 location',
  'clinic 2 gps location',
  'clinic2 location',
  'clinic 2 gps',
  'clinic2 gps location',
  'clinic_2_location',
  'clinic_2_gps_location',
  'clinic 2 map',
  'clinic 2 map link',
  'gps 2',
  'location 2',
  'location gps 2',
  'google maps 2',
  'maps 2',
  'clinic 2 address',
  'address 2',
  'second clinic location',
  'عنوان عيادة 2',
  'عنوان عياده 2',
  'لوكيشن عيادة 2',
  'لوكيشن عياده 2',
  'موقع عيادة 2',
  'موقع عياده 2',
  'عنوان العيادة 2',
  'عنوان العياده 2',
].map(normalizeHeader);

function matchLocationColumn(
  headers: string[],
  synonyms: string[],
  clinicNum: 1 | 2,
  exclude?: Set<string>
): string {
  const normalizedPairs = headers
    .filter((h) => !exclude?.has(h))
    .map((h) => ({ raw: h, norm: normalizeHeader(h) }));

  // 1. Exact synonym match first
  for (const syn of synonyms) {
    const exact = normalizedPairs.find((p) => p.norm === syn);
    if (exact) return exact.raw;
  }

  // 2. Fuzzy fallback with strict Clinic 1 vs Clinic 2 guard
  const locationKeyword =
    /(?:gps|location|map|maps|coord|address|pin|link|url|عنوان|لوكيشن|موقع)/i;
  const excludeNonLocation =
    /(?:visiting\s*time|time\s*of\s*visit|schedule|hours|specialty|speciality|target|baseline|notes|comment|remark)/i;

  for (const p of normalizedPairs) {
    if (!locationKeyword.test(p.norm)) continue;
    if (excludeNonLocation.test(p.norm)) continue;
    if (clinicNum === 2) {
      if (isClinic2Header(p.norm) && !isClinic1Header(p.norm)) {
        return p.raw;
      }
    } else {
      if (!isClinic2Header(p.norm)) {
        return p.raw;
      }
    }
  }

  return '';
}

function matchHeader(headers: string[], candidates: RegExp[], exclude?: Set<string>): string {
  for (const regex of candidates) {
    const found = headers.find((h) => {
      if (exclude?.has(h)) return false;
      const norm = normalizeHeader(h);
      return regex.test(norm) || regex.test(h.trim());
    });
    if (found) return found;
  }
  return '';
}

/**
 * Scores an unmapped column by how many sample cells parse as real visiting schedules
 * (excluding pure GPS coordinate pairs and plain numeric IDs/targets).
 */
function scoreColumnAsScheduleContent(header: string, sampleRows: Record<string, unknown>[]): number {
  let nonEmpty = 0;
  let validScheduleHits = 0;
  for (const row of sampleRows.slice(0, 30)) {
    const raw = String(row[header] ?? '').replace(/[\r\n]+/g, ' | ').trim();
    if (!raw) continue;
    nonEmpty++;
    // Skip URLs, pure GPS lat/lng, or pure single numbers
    if (/^https?:\/\//i.test(raw)) continue;
    if (/^-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}$/.test(raw)) continue;
    if (/^\d+(?:\.\d+)?$/.test(raw)) continue;
    const parsed = parseSchedule(raw);
    if (
      parsed.windows.length > 0 &&
      (parsed.status === 'PARSED_HIGH_CONFIDENCE' || parsed.status === 'AMBIGUOUS')
    ) {
      validScheduleHits++;
    }
  }
  if (nonEmpty === 0 || validScheduleHits === 0) return 0;
  const ratio = validScheduleHits / nonEmpty;
  if (validScheduleHits >= 2 || (nonEmpty <= 4 && ratio >= 0.5)) {
    return validScheduleHits + ratio;
  }
  return 0;
}

const TARGET_ID_SYNONYMS: string[] = [
  'target_id',
  'target id',
  'targetid',
  'hcp id',
  'hcp_id',
  'doctor id',
  'doctor_id',
  'id',
  'code',
  'account id',
  'sfdc id',
  'crm id',
  'كود',
  'الكود',
  'رقم الطبيب',
  'كود الطبيب',
].map(normalizeHeader);

const FREQUENCY_PER_QUARTER_SYNONYMS: string[] = [
  'frequency per quarter',
  'quarterly frequency',
  'frequency_per_quarter',
  'quarter target',
  'quarterly target',
  'quarter_target',
  'quarterly_target',
  'quarterly visits',
  'visits per quarter',
  'visits/quarter',
  'target frequency',
  'frequency',
  'freq',
  'call frequency',
  'call freq',
  'q target',
  'q_target',
  'qtr target',
  'target visits',
  'visit target',
  'target',
  'visits',
  'no of visits',
  'number of visits',
  'عدد الزيارات',
  'الزيارات',
  'معدل الزيارات',
  'التارجت',
  'تارجت الربع',
  'هدف الربع',
  'تارجت',
].map(normalizeHeader);

function isIdOrCodeColumn(normHeader: string): boolean {
  return /(?:^|\s)(?:id|targetid|hcpid|doctorid|code|sfdc|crm)(?:\s|$)|كود|الكود|رقم\s*الطبيب/.test(
    normHeader
  );
}

function matchTargetIdColumn(headers: string[], exclude?: Set<string>): string {
  const normalizedPairs = headers
    .filter((h) => !exclude?.has(h))
    .map((h) => ({ raw: h, norm: normalizeHeader(h) }));

  // 1. Exact synonym match first
  for (const syn of TARGET_ID_SYNONYMS) {
    const exact = normalizedPairs.find((p) => p.norm === syn);
    if (exact) return exact.raw;
  }

  // 2. Fuzzy fallback for ID / Code columns
  for (const p of normalizedPairs) {
    if (isIdOrCodeColumn(p.norm)) {
      return p.raw;
    }
  }
  return '';
}

function matchFrequencyPerQuarterColumn(headers: string[], exclude?: Set<string>): string {
  // NEVER allow any column already claimed or containing "id" or "code" (like target_id) to match!
  const normalizedPairs = headers
    .filter((h) => !exclude?.has(h))
    .map((h) => ({ raw: h, norm: normalizeHeader(h) }))
    .filter((p) => !isIdOrCodeColumn(p.norm));

  // 1. Exact synonym match first
  for (const syn of FREQUENCY_PER_QUARTER_SYNONYMS) {
    const exact = normalizedPairs.find((p) => p.norm === syn);
    if (exact) return exact.raw;
  }

  // 2. Fuzzy fallback (excluding baseline/completed/prior visit columns and schedule/time columns)
  const excludeNonTarget =
    /(?:baseline|completed|actual|prior|history|visiting\s*time|time\s*of\s*visit|schedule|hours|timing|gps|location|map|zone|brick|area|name|specialt|specialit|note|comment)/i;
  const targetKeyword =
    /(?:frequency|freq|quarter(?:ly)?\s*target|q(?:tr)?\s*target|target\s*visits?|visit\s*target|visits?\s*per\s*(?:quarter|month)|monthly\s*(?:target|frequency|visits?)|number\s*of\s*visits|no\s*of\s*visits|\btarget\b|\bvisits\b|عدد\s*الزيارات|معدل\s*الزيارات|تارجت|التارجت|هدف\s*الربع|الزيارات)/i;

  for (const p of normalizedPairs) {
    if (excludeNonTarget.test(p.norm)) continue;
    if (targetKeyword.test(p.norm)) {
      return p.raw;
    }
  }

  return '';
}

const ARABIC_PERSIAN_DIGIT_MAP: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

function toAsciiDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (ch) => ARABIC_PERSIAN_DIGIT_MAP[ch] ?? ch);
}

function isExplicitlyMonthlyHeader(headerName?: string): boolean {
  if (!headerName) return false;
  const norm = normalizeHeader(headerName);
  return /\bmonth(?:ly)?\b|per\s*month|\/m\b|شهري|شهرى|بالشهر|في\s*الشهر/.test(norm);
}

/**
 * Dedicated Quarter Target (Frequency per Quarter) parser:
 * 1. If SheetJS cell `cell.t === 'n'` and `typeof cell.v === 'number'` (including evaluated formulas!),
 *    uses `Math.round(cell.v)` directly — NEVER reads raw formula string `cell.f`.
 * 2. Otherwise reads display text (`cell.w ?? String(cell.v ?? '')`), converts Arabic/Persian digits to ASCII.
 * 3. Extracts numeric value cleanly from `"6"`, `"6.0"`, `"12"`, `"6 visits"`, `"6/Q"`, `"6 / quarter"`, `"6x"`, `"Target: 6"`.
 * 4. Multiplies by 3 ONLY if headerName explicitly says `"month"` / `"monthly"` / `"شهري"`.
 * 5. Accepts any integer in `1..60`.
 * 6. Only falls back to `8` if blank or invalid, returning an explicit amber warning.
 */
export function parseQuarterlyTarget(
  cell: unknown,
  headerName = ''
): QuarterlyTargetParseResult {
  const isMonthly = isExplicitlyMonthlyHeader(headerName);
  let extractedNumber: number | null = null;
  let rawText = '';

  if (typeof cell === 'number' && Number.isFinite(cell)) {
    extractedNumber = Math.round(cell);
    rawText = String(cell);
  } else if (cell && typeof cell === 'object') {
    const cellObj = cell as { t?: unknown; v?: unknown; w?: unknown; f?: unknown };
    if (cellObj.t === 'n' && typeof cellObj.v === 'number' && Number.isFinite(cellObj.v)) {
      extractedNumber = Math.round(cellObj.v);
      rawText = String(cellObj.w ?? cellObj.v);
    } else {
      rawText =
        cellObj.w !== undefined && cellObj.w !== null
          ? String(cellObj.w)
          : cellObj.v !== undefined && cellObj.v !== null
            ? String(cellObj.v)
            : '';
    }
  } else if (cell !== undefined && cell !== null) {
    rawText = String(cell);
  }

  if (extractedNumber === null) {
    const normalizedText = toAsciiDigits(rawText)
      .replace(/[\u00A0\u200B-\u200F\u202A-\u202E\uFEFF]/g, ' ')
      .trim();

    if (normalizedText) {
      // Strip leading quarter label like "Q1:" or "Quarter 4 -" if another number follows
      const strippedQuarterPrefix = normalizedText.replace(
        /^(?:q(?:tr|uarter)?|ربع)\s*[1-4]\s*[:\-–—/]\s*(?=\d)/i,
        ''
      );
      const numMatch = strippedQuarterPrefix.match(/(-?\d+(?:\.\d+)?)/);
      if (numMatch) {
        const parsed = parseFloat(numMatch[1]);
        if (Number.isFinite(parsed)) {
          extractedNumber = Math.round(parsed);
        }
      }
    }
  }

  if (extractedNumber === null || !Number.isFinite(extractedNumber)) {
    return {
      value: 8,
      defaultedToEight: true,
      multipliedMonthly: false,
      warning: 'Missing/invalid target; defaulted to 8',
      note: null,
      rawText: rawText.trim(),
    };
  }

  const finalValue = isMonthly ? Math.round(extractedNumber * 3) : extractedNumber;

  if (finalValue < 1 || finalValue > 60) {
    return {
      value: 8,
      defaultedToEight: true,
      multipliedMonthly: false,
      warning: 'Missing/invalid target; defaulted to 8',
      note: null,
      rawText: rawText.trim(),
    };
  }

  return {
    value: finalValue,
    defaultedToEight: false,
    multipliedMonthly: isMonthly,
    warning: null,
    note: isMonthly
      ? `Monthly target (${extractedNumber}) × 3 = ${finalValue} visits/quarter`
      : null,
    rawText: rawText.trim(),
  };
}

export function autoDetectColumns(
  headers: string[],
  sampleRows: Record<string, unknown>[] = []
): ColumnMapping {
  const used = new Set<string>();

  // 1. Map TARGET_ID FIRST so `target_id` NEVER collides with Quarter Target or anything else
  const targetId = matchTargetIdColumn(headers, used);
  if (targetId) used.add(targetId);

  // 2. Map clinic schedules (excluding targetId)
  let schedule2 = matchScheduleColumn(headers, CLINIC_2_SCHEDULE_SYNONYMS, 2, targetId);
  if (schedule2) used.add(schedule2);
  let schedule1 = matchScheduleColumn(headers, CLINIC_1_SCHEDULE_SYNONYMS, 1, schedule2);
  if (schedule1 && used.has(schedule1)) {
    schedule1 = '';
  }
  if (schedule1) used.add(schedule1);

  const hcpName = matchHeader(
    headers,
    [
      /^hcp name$/,
      /^doctor name$/,
      /^dr name$/,
      /^physician name$/,
      /^customer name$/,
      /^account name$/,
      /^doctor$/,
      /^hcp$/,
      /^name$/,
      /اسم|الاسم|الدكتور|دكتور|طبيب/,
    ],
    used
  );
  if (hcpName) used.add(hcpName);

  const specialty = matchHeader(
    headers,
    [/^specialt(?:y|ies)$/, /^specialit(?:y|ies)$/, /^spec$/, /التخصص|تخصص/],
    used
  );
  if (specialty) used.add(specialty);

  const zone2 = matchHeader(
    headers,
    [/^zone 2$/, /^brick 2$/, /^area 2$/, /^clinic 2 zone$/, /^clinic 2 brick$/, /منطقة 2|المنطقة 2/],
    used
  );
  if (zone2) used.add(zone2);

  const zone1 = matchHeader(
    headers,
    [/^zone 1$/, /^brick 1$/, /^area 1$/, /^clinic 1 zone$/, /^clinic 1 brick$/, /^zone$/, /^brick$/, /المنطقة|منطقة/],
    used
  );
  if (zone1) used.add(zone1);

  const locationGps2 = matchLocationColumn(headers, CLINIC_2_LOCATION_SYNONYMS, 2, used);
  if (locationGps2) used.add(locationGps2);

  const locationGps1 = matchLocationColumn(headers, CLINIC_1_LOCATION_SYNONYMS, 1, used);
  if (locationGps1) used.add(locationGps1);

  // 3. Map baseline/prior visits before FREQUENCY_PER_QUARTER so "completed visits" isn't mistaken for target
  const baselineVisits = matchHeader(
    headers,
    [
      /^(?:imported )?baseline visits?$/,
      /^completed visits?$/,
      /^actual visits?$/,
      /^prior visits?$/,
    ],
    used
  );
  if (baselineVisits) used.add(baselineVisits);

  // 4. Map FREQUENCY_PER_QUARTER (Quarter Target) strictly excluding any ID/Code column
  const quarterlyTarget = matchFrequencyPerQuarterColumn(headers, used);
  if (quarterlyTarget) used.add(quarterlyTarget);

  const notes = matchHeader(headers, [/^notes?$/, /^comments?$/, /^remarks?$/, /ملاحظات/], used);
  if (notes) used.add(notes);

  // Detect any unmapped day column containing "day" / "أيام" / "ايام" / "يوم"
  let days1 = '';
  let days2 = '';
  const dayColRegex = /\bday(?:s)?\b|أيام|ايام|يوم/i;
  for (const h of headers) {
    if (used.has(h)) continue;
    const norm = normalizeHeader(h);
    if (!dayColRegex.test(norm)) continue;
    if (isClinic2Header(norm) || /ثان/.test(norm)) {
      if (!days2) {
        days2 = h;
        used.add(h);
      }
    } else {
      if (!days1) {
        days1 = h;
        used.add(h);
      }
    }
  }

  // Content-based fallback: if schedule1 (or schedule2) wasn't matched by column name,
  // inspect actual sample cells across remaining unmapped columns.
  if ((!schedule1 || !schedule2) && sampleRows.length > 0) {
    const scored = headers
      .filter((h) => !used.has(h))
      .map((h) => ({
        header: h,
        norm: normalizeHeader(h),
        score: scoreColumnAsScheduleContent(h, sampleRows),
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    for (const cand of scored) {
      if (!schedule1 && !isClinic2Header(cand.norm)) {
        schedule1 = cand.header;
        used.add(cand.header);
      } else if (!schedule2 && (isClinic2Header(cand.norm) || schedule1)) {
        schedule2 = cand.header;
        used.add(cand.header);
      }
      if (schedule1 && schedule2) break;
    }
  }

  return {
    targetId,
    hcpName,
    specialty,
    zone1,
    zone2,
    locationGps1,
    locationGps2,
    schedule1,
    schedule2,
    days1,
    days2,
    quarterlyTarget,
    baselineVisits,
    notes,
  };
}

const HEADER_SCORE_REGEX =
  /(?:name|doctor|hcp|target|specialty|speciality|zone|brick|area|gps|map|location|time|visit|schedule|hours|clinic|day|notes|اسم|تخصص|منطقة|مواعيد|وقت|عيادة|عياده)/i;

export function readSpreadsheetFile(
  buffer: ArrayBuffer,
  sheetNameOverride?: string
): ParsedWorkbookSheet {
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheetNames = wb.SheetNames;
  const selectedSheet =
    sheetNameOverride && sheetNames.includes(sheetNameOverride)
      ? sheetNameOverride
      : sheetNames[0] || '';

  const sheet = wb.Sheets[selectedSheet];
  if (!sheet) {
    return {
      sheetNames,
      selectedSheet,
      headers: [],
      rows: [],
      detectedMapping: autoDetectColumns([]),
    };
  }

  // Iterate cell-by-cell over sheet['!ref'] so Excel hyperlinks (cell.l.Target / cell.l.location),
  // HYPERLINK("url", "label") formulas, and numeric evaluated formula cells (cell.t === 'n', cell.v) are preserved!
  const matrix: string[][] = [];
  const rawCellMatrix: Array<Array<XLSX.CellObject | undefined>> = [];
  if (sheet['!ref']) {
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const numRows = range.e.r - range.s.r + 1;
    const numCols = range.e.c - range.s.c + 1;

    for (let r = 0; r < numRows; r++) {
      const rowArr: string[] = new Array<string>(numCols).fill('');
      const cellRowArr: Array<XLSX.CellObject | undefined> = new Array<XLSX.CellObject | undefined>(
        numCols
      ).fill(undefined);
      for (let c = 0; c < numCols; c++) {
        const addr = XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c });
        const cell = sheet[addr] as XLSX.CellObject | undefined;
        if (!cell) continue;
        cellRowArr[c] = cell;

        // If cell is numeric (including evaluated numeric formulas), prefer cell.v if cell.w is missing
        const displayText =
          cell.t === 'n' && typeof cell.v === 'number' && Number.isFinite(cell.v)
            ? String(cell.v)
            : cell.w !== undefined && cell.w !== null
              ? String(cell.w)
              : cell.v !== undefined && cell.v !== null
                ? String(cell.v)
                : '';

        let hyperlinkTarget = (
          cell.l?.Target ||
          (cell.l as { location?: string } | undefined)?.location ||
          ''
        ).trim();
        if (!hyperlinkTarget && typeof cell.f === 'string') {
          const fMatch = cell.f.match(/HYPERLINK\(\s*"([^"]+)"/i);
          if (fMatch && fMatch[1]) {
            hyperlinkTarget = fMatch[1].trim();
          }
        }

        const trimmedDisplay = displayText.trim();
        if (hyperlinkTarget && !/^https?:\/\//i.test(trimmedDisplay)) {
          rowArr[c] = trimmedDisplay ? `${hyperlinkTarget} (${trimmedDisplay})` : hyperlinkTarget;
        } else {
          rowArr[c] = displayText;
        }
      }
      matrix.push(rowArr);
      rawCellMatrix.push(cellRowArr);
    }
  }

  let headerRowIdx = 0;
  let bestScore = -1;
  const scanLimit = Math.min(10, matrix.length);
  for (let r = 0; r < scanLimit; r++) {
    const rowArr = matrix[r];
    if (!Array.isArray(rowArr)) continue;
    let nonEmpty = 0;
    let keywordHits = 0;
    for (const cell of rowArr) {
      const text = String(cell ?? '').trim();
      if (!text) continue;
      nonEmpty++;
      if (HEADER_SCORE_REGEX.test(normalizeHeader(text))) {
        keywordHits++;
      }
    }
    const score = keywordHits * 3 + Math.min(nonEmpty, 8) * 0.25;
    if (keywordHits > 0 && score > bestScore) {
      bestScore = score;
      headerRowIdx = r;
    }
  }

  const rawHeaderRow = Array.isArray(matrix[headerRowIdx]) ? matrix[headerRowIdx] : [];
  const headers: string[] = [];
  const seenCounts = new Map<string, number>();

  rawHeaderRow.forEach((cell) => {
    const base = String(cell ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!base) {
      headers.push('');
      return;
    }
    const prev = seenCounts.get(base) || 0;
    seenCounts.set(base, prev + 1);
    // Label duplicate headers cleanly as "(2)", "(3)" so Clinic 2 columns auto-detect
    headers.push(prev === 0 ? base : `${base} (${prev + 1})`);
  });

  // Ensure any trailing non-empty data columns without header still get a fallback key
  let maxCols = headers.length;
  for (const dataRow of matrix.slice(headerRowIdx + 1, headerRowIdx + 30)) {
    if (Array.isArray(dataRow) && dataRow.length > maxCols) {
      maxCols = dataRow.length;
    }
  }
  while (headers.length < maxCols) {
    headers.push('');
  }
  const finalHeaders = headers.map((h, i) => h || `Column ${i + 1}`);

  const rows: Record<string, unknown>[] = [];
  for (let r = headerRowIdx + 1; r < matrix.length; r++) {
    const rowArr = matrix[r];
    const rawCellsRow = rawCellMatrix[r] || [];
    if (!Array.isArray(rowArr)) continue;
    let hasAnyValue = false;
    const obj: Record<string, unknown> = {};
    const cellsByHeader: Record<string, XLSX.CellObject | undefined> = {};
    for (let c = 0; c < finalHeaders.length; c++) {
      const val = rowArr[c] !== undefined && rowArr[c] !== null ? String(rowArr[c]) : '';
      if (val.trim()) hasAnyValue = true;
      obj[finalHeaders[c]] = val;
      if (rawCellsRow[c]) {
        cellsByHeader[finalHeaders[c]] = rawCellsRow[c];
      }
    }
    if (hasAnyValue) {
      Object.defineProperty(obj, '__rawCells', {
        value: cellsByHeader,
        enumerable: false,
        configurable: true,
      });
      rows.push(obj);
    }
  }

  const nonEmptyHeaders = finalHeaders.filter((h, idx) =>
    Boolean(headers[idx]) || rows.some((r) => String(r[h] ?? '').trim().length > 0)
  );

  return {
    sheetNames,
    selectedSheet,
    headers: nonEmptyHeaders,
    rows,
    detectedMapping: autoDetectColumns(nonEmptyHeaders, rows),
  };
}

function cellStr(row: Record<string, unknown>, col?: string): string {
  if (!col) return '';
  const val = row[col];
  if (val === undefined || val === null) return '';
  return String(val).trim();
}

/**
 * Extracts schedule cell text, replacing line breaks with " | " so multi-line schedules stay separated into clauses.
 */
function scheduleCellStr(row: Record<string, unknown>, schedCol?: string, daysCol?: string): string {
  const sched = cellStr(row, schedCol).replace(/[\r\n]+/g, ' | ').trim();
  const days = cellStr(row, daysCol).replace(/[\r\n]+/g, ' ').trim();
  if (days && sched) {
    return `${days} ${sched}`;
  }
  return sched || days;
}

function cellNum(row: Record<string, unknown>, col: string, fallback: number): number {
  const s = cellStr(row, col);
  if (!s) return fallback;
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Builds an import preview against existing Firestore HCPs & Clinics.
 * Strictly separates Clinic 1 & Clinic 2 (never copies visiting hours between clinics),
 * and protects manually confirmed schedules & verified GPS!
 */
export function buildImportPreview(params: {
  userId: string;
  workbookName: string;
  sheetName: string;
  rows: Record<string, unknown>[];
  mapping: ColumnMapping;
  existingHcps: Hcp[];
  existingClinics: Clinic[];
  currentQuarterLabel: string;
  defaultVisitDurationMinutes: number;
  allowBlankOverwrite?: boolean;
}): ImportPreviewSummary {
  const {
    userId,
    workbookName,
    sheetName,
    rows,
    mapping,
    existingHcps,
    existingClinics,
    currentQuarterLabel,
    defaultVisitDurationMinutes,
    allowBlankOverwrite = false,
  } = params;

  const hcpByTargetId = new Map<string, Hcp>(existingHcps.map((h) => [h.targetId, h]));
  const clinicByKey = new Map<string, Clinic>(existingClinics.map((c) => [c.clinicKey, c]));

  const previewRows: ImportPreviewRow[] = [];
  let newHcps = 0;
  let updatedHcps = 0;
  let totalClinics = 0;
  let totalQuarterlyTarget = 0;
  let defaultedQuarterlyTargetCount = 0;
  let monthlyMultipliedCount = 0;
  let highConfidenceSchedules = 0;
  let ambiguousSchedules = 0;
  let protectedSchedulesPreserved = 0;
  let protectedGpsPreserved = 0;
  const now = Date.now();

  rows.forEach((row, idx) => {
    const rowNumber = idx + 2; // Excel row index (1-based header + data)
    const name = cellStr(row, mapping.hcpName);
    let targetId = cellStr(row, mapping.targetId);
    if (!name && !targetId) return;
    if (!targetId) {
      targetId = `ROW_${rowNumber}`;
    }

    const existingHcp = hcpByTargetId.get(targetId);
    const isNewHcp = !existingHcp;
    if (isNewHcp) newHcps++;
    else updatedHcps++;

    const specialty = cellStr(row, mapping.specialty) || existingHcp?.specialty || 'General';
    const zone1 = cellStr(row, mapping.zone1) || existingHcp?.zone || '';
    const zone2 = cellStr(row, mapping.zone2);

    const rawCellsMap = (row as { __rawCells?: Record<string, XLSX.CellObject | undefined> })
      .__rawCells;
    const rawTargetCell = mapping.quarterlyTarget
      ? rawCellsMap?.[mapping.quarterlyTarget] ?? row[mapping.quarterlyTarget]
      : undefined;
    const parsedTarget = parseQuarterlyTarget(rawTargetCell, mapping.quarterlyTarget);
    const quarterlyTarget = parsedTarget.value;

    totalQuarterlyTarget += quarterlyTarget;
    if (parsedTarget.defaultedToEight) {
      defaultedQuarterlyTargetCount++;
    }
    if (parsedTarget.multipliedMonthly) {
      monthlyMultipliedCount++;
    }

    const baselineVisits = Math.max(
      0,
      Math.round(cellNum(row, mapping.baselineVisits, existingHcp?.importedBaselineVisits ?? 0))
    );
    const notes = cellStr(row, mapping.notes) || existingHcp?.notes || '';

    const hcp: Omit<Hcp, 'id'> = {
      userId,
      targetId,
      name: name || existingHcp?.name || `HCP ${targetId}`,
      specialty,
      quarterlyTarget,
      priorityScore: existingHcp?.priorityScore ?? 60,
      zone: zone1,
      isActive: existingHcp?.isActive ?? true,
      defaultVisitDurationMinutes:
        existingHcp?.defaultVisitDurationMinutes ?? defaultVisitDurationMinutes,
      importedBaselineVisits: baselineVisits,
      baselineQuarterLabel: currentQuarterLabel || getQuarterLabel(),
      historyIncomplete: existingHcp?.historyIncomplete ?? false,
      notes,
      sourceWorkbook: workbookName,
      version: (existingHcp?.version ?? 0) + 1,
      isDeleted: false,
      createdAt: existingHcp?.createdAt ?? now,
      updatedAt: now,
    };

    const rowClinics: Array<Omit<Clinic, 'id'>> = [];
    const warnings: string[] = [];
    if (parsedTarget.warning) {
      warnings.push(parsedTarget.warning);
    }
    let rowProtectedSchedule = 0;
    let rowProtectedGps = 0;

    const buildClinic = (
      clinicIndex: number,
      zoneVal: string,
      gpsRaw: string,
      scheduleRawInput: string,
      sourceCol: string
    ) => {
      const cKey = clinicKeyFor(targetId, clinicIndex);
      const existingClinic = clinicByKey.get(cKey);

      // If no dedicated schedule cell was populated, check if location/GPS cell embeds time text
      const scheduleRaw =
        scheduleRawInput.trim() ||
        (looksLikeEmbeddedScheduleText(gpsRaw) ? gpsRaw.replace(/[\r\n]+/g, ' | ').trim() : '');

      const isManualProtected = Boolean(
        existingClinic &&
          (existingClinic.isManualUserConfirmed || existingClinic.userConfirmedSchedule)
      );
      const existingHasSchedule = Boolean(
        existingClinic &&
          ((existingClinic.windows && existingClinic.windows.length > 0) ||
            (existingClinic.rawScheduleText || existingClinic.originalExcelScheduleText || '').trim()
              .length > 0)
      );
      // Never let a blank Excel cell wipe out existing valid clinic hours unless Blank Cells Overwrite is enabled
      const preserveExistingSchedule =
        isManualProtected || (!scheduleRaw && !allowBlankOverwrite && existingHasSchedule);

      const isGpsProtected = Boolean(
        existingClinic &&
          existingClinic.geocodingStatus === 'VERIFIED' &&
          existingClinic.latitude !== null &&
          existingClinic.longitude !== null
      );

      if (isManualProtected) {
        rowProtectedSchedule++;
        protectedSchedulesPreserved++;
      }
      if (isGpsProtected) {
        rowProtectedGps++;
        protectedGpsPreserved++;
      }

      const effectiveZone = zoneVal || existingClinic?.zone || (clinicIndex === 1 ? zone1 : '');
      const parsedGeo = extractCoordinates(
        gpsRaw || scheduleRaw,
        effectiveZone,
        `${targetId}::C${clinicIndex}`
      );
      const parsed = parseSchedule(scheduleRaw);
      const classification = classifyScheduleResult(parsed);
      const isValidParsed =
        parsed.windows.length > 0 &&
        (parsed.status === 'PARSED_HIGH_CONFIDENCE' || parsed.status === 'CONFIRMED');

      const finalScheduleStatus = preserveExistingSchedule
        ? existingClinic!.scheduleParseStatus
        : parsed.status;

      if (
        finalScheduleStatus === 'CONFIRMED' ||
        finalScheduleStatus === 'PARSED_HIGH_CONFIDENCE'
      ) {
        highConfidenceSchedules++;
      } else {
        ambiguousSchedules++;
        warnings.push(
          `Clinic ${clinicIndex}: ${
            preserveExistingSchedule
              ? existingClinic!.scheduleAmbiguityReason || 'Schedule needs review.'
              : parsed.ambiguityReason || 'Schedule needs review.'
          }`
        );
      }

      const clinicObj: Omit<Clinic, 'id'> = {
        userId,
        clinicKey: cKey,
        hcpTargetId: targetId,
        clinicIndex,
        label: existingClinic?.label || `Clinic ${clinicIndex}`,
        zone: zoneVal || existingClinic?.zone || (clinicIndex === 1 ? zone1 : ''),
        originalLocationText: gpsRaw || existingClinic?.originalLocationText || '',
        googleMapsUrl: isGpsProtected
          ? existingClinic!.googleMapsUrl
          : parsedGeo.googleMapsUrl || existingClinic?.googleMapsUrl || '',
        latitude: isGpsProtected
          ? existingClinic!.latitude
          : parsedGeo.latitude ?? existingClinic?.latitude ?? null,
        longitude: isGpsProtected
          ? existingClinic!.longitude
          : parsedGeo.longitude ?? existingClinic?.longitude ?? null,
        geocodingStatus: isGpsProtected
          ? 'VERIFIED'
          : parsedGeo.geocodingStatus !== 'MISSING'
            ? parsedGeo.geocodingStatus
            : existingClinic?.geocodingStatus || 'MISSING',
        rawScheduleText: preserveExistingSchedule
          ? existingClinic!.rawScheduleText
          : scheduleRaw,
        originalExcelScheduleText:
          scheduleRaw ||
          (preserveExistingSchedule ? existingClinic!.originalExcelScheduleText : ''),
        normalizedDaysCsv: preserveExistingSchedule
          ? existingClinic!.normalizedDaysCsv
          : parsed.normalizedDays.join(','),
        excludedDaysCsv: preserveExistingSchedule
          ? existingClinic!.excludedDaysCsv
          : parsed.excludedDays.join(','),
        scheduleParseStatus: finalScheduleStatus,
        scheduleClassification: preserveExistingSchedule
          ? existingClinic!.scheduleClassification
          : classification,
        parsingMethod: preserveExistingSchedule ? existingClinic!.parsingMethod : 'DETERMINISTIC',
        validationStatus: preserveExistingSchedule
          ? existingClinic!.validationStatus
          : isValidParsed
            ? 'VALID'
            : 'NEEDS_REVIEW',
        userConfirmedSchedule: isManualProtected
          ? true
          : preserveExistingSchedule
            ? Boolean(existingClinic!.userConfirmedSchedule)
            : false,
        isManualUserConfirmed: isManualProtected
          ? true
          : preserveExistingSchedule
            ? Boolean(existingClinic!.isManualUserConfirmed)
            : false,
        isActive: existingClinic?.isActive ?? true,
        scheduleAmbiguityReason: preserveExistingSchedule
          ? existingClinic!.scheduleAmbiguityReason || ''
          : parsed.ambiguityReason,
        sourceSheet: sheetName,
        sourceRow: rowNumber,
        sourceColumn: sourceCol,
        windows: preserveExistingSchedule ? existingClinic!.windows : parsed.windows,
        version: (existingClinic?.version ?? 0) + 1,
        createdAt: existingClinic?.createdAt ?? now,
        updatedAt: now,
      };

      rowClinics.push(clinicObj);
      totalClinics++;
    };

    // Extract raw GPS & Schedule cells for Clinic 1 & Clinic 2
    const rawGps1 = cellStr(row, mapping.locationGps1);
    const rawGps2 = cellStr(row, mapping.locationGps2);
    const sched1 = scheduleCellStr(row, mapping.schedule1, mapping.days1);
    const sched2 = scheduleCellStr(row, mapping.schedule2, mapping.days2);

    // Multi-location reference splitting: if a single Location cell contains 2 URLs/coords
    // and there is no separate Clinic 2 Location value, map refs[0] -> Clinic 1 and refs[1] -> Clinic 2.
    const gps1Refs = splitLocationReferences(rawGps1);
    const hasClinic2 = Boolean(zone2 || rawGps2 || sched2 || (!rawGps2 && gps1Refs.length >= 2));
    const gps1 = !rawGps2 && gps1Refs.length >= 2 ? gps1Refs[0] : rawGps1;
    const gps2 = rawGps2 || (gps1Refs.length >= 2 ? gps1Refs[1] : '');

    // Clinic 1 is always created for every HCP row (strictly using Clinic 1 columns only)
    buildClinic(1, zone1, gps1, sched1, mapping.schedule1 || 'visiting time in clinic 1');

    // Clinic 2 is created strictly separately if any Clinic 2 field is populated (NEVER copies Clinic 1 hours!)
    if (hasClinic2) {
      buildClinic(2, zone2, gps2, sched2, mapping.schedule2 || 'visiting time in clinic 2');
    }

    previewRows.push({
      rowNumber,
      hcp,
      clinics: rowClinics,
      isNewHcp,
      protectedScheduleCount: rowProtectedSchedule,
      protectedGpsCount: rowProtectedGps,
      quarterlyTargetDefaulted: parsedTarget.defaultedToEight,
      quarterlyTargetMonthlyMultiplied: parsedTarget.multipliedMonthly,
      quarterlyTargetNote: parsedTarget.note || parsedTarget.warning,
      rawQuarterlyTargetText: parsedTarget.rawText,
      warnings,
    });
  });

  return {
    rows: previewRows,
    totalHcps: previewRows.length,
    newHcps,
    updatedHcps,
    totalClinics,
    totalQuarterlyTarget,
    defaultedQuarterlyTargetCount,
    monthlyMultipliedCount,
    highConfidenceSchedules,
    ambiguousSchedules,
    protectedSchedulesPreserved,
    protectedGpsPreserved,
  };
}

/**
 * Generates and downloads a Territory Rx compliant sample .xlsx workbook.
 */
export function downloadSampleWorkbook(): void {
  const sampleRows = [
    {
      target_id: 'TRX-1001',
      'HCP Name': 'Dr. Karim Mansour',
      Specialty: 'Cardiology',
      'zone 1': 'Maadi',
      'zone 2': 'Heliopolis',
      'location GPS': 'https://www.google.com/maps/@29.960241,31.256913,17z',
      'Visiting Time in Clinic 1': 'Sat, Mon, Wed 6-10 PM',
      'location GPS 2': '30.091021, 31.322481',
      'Visiting Time in Clinic 2': 'Sunday, Tuesday 5-9 PM',
      'Quarterly Target': 6,
      'Baseline Visits': 2,
    },
    {
      target_id: 'TRX-1002',
      'HCP Name': 'د. سارة العشري',
      Specialty: 'Endocrinology',
      'zone 1': 'Maadi',
      'zone 2': '',
      'location GPS': '29.960255, 31.256920',
      'Visiting Time in Clinic 1': 'يومياً من ٤ إلى ٧ مساءً ما عدا الجمعة',
      'location GPS 2': '',
      'Visiting Time in Clinic 2': '',
      'Quarterly Target': 6,
      'Baseline Visits': 1,
    },
    {
      target_id: 'TRX-1003',
      'HCP Name': 'Dr. Tarek El-Sayed',
      Specialty: 'Internal Medicine',
      'zone 1': 'Nasr City',
      'zone 2': '',
      'location GPS': 'https://maps.google.com/?q=30.056122,31.330109',
      'Visiting Time in Clinic 1': 'Daily 8 PM-10 PM, Friday 5 PM-7 PM',
      'location GPS 2': '',
      'Visiting Time in Clinic 2': '',
      'Quarterly Target': 4,
      'Baseline Visits': 0,
    },
    {
      target_id: 'TRX-1004',
      'HCP Name': 'د. أحمد فؤاد',
      Specialty: 'Neurology',
      'zone 1': 'Mohandessin',
      'zone 2': 'Dokki',
      'location GPS': '30.051104, 31.204192',
      'Visiting Time in Clinic 1': 'السبت والاثنين من 5م ل 8م',
      'location GPS 2': '30.038412, 31.211820',
      'Visiting Time in Clinic 2': 'Monday, Tuesday, Thursday; 8 PM – 10 PM',
      'Quarterly Target': 6,
      'Baseline Visits': 3,
    },
  ];

  const ws = XLSX.utils.json_to_sheet(sampleRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Territory_HCPs');
  XLSX.writeFile(wb, 'TerritoryRx_Sample_Template.xlsx');
}

/**
 * Exports active Territory Rx HCPs and their separate Clinic 1 & Clinic 2 records to .xlsx.
 */
export function exportTerritoryWorkbook(hcps: Hcp[], clinics: Clinic[]): void {
  const clinicsByHcp = new Map<string, Clinic[]>();
  for (const c of clinics) {
    const list = clinicsByHcp.get(c.hcpTargetId) || [];
    list.push(c);
    list.sort((a, b) => a.clinicIndex - b.clinicIndex);
    clinicsByHcp.set(c.hcpTargetId, list);
  }

  const rows = hcps
    .filter((h) => !h.isDeleted)
    .map((h) => {
      const hClinics = clinicsByHcp.get(h.targetId) || [];
      const c1 = hClinics.find((c) => c.clinicIndex === 1) || hClinics[0];
      const c2 = hClinics.find((c) => c.clinicIndex === 2) || hClinics[1];
      return {
        target_id: h.targetId,
        'HCP Name': h.name,
        Specialty: h.specialty,
        'zone 1': c1?.zone || h.zone || '',
        'zone 2': c2?.zone || '',
        'location GPS':
          c1?.latitude !== null &&
          c1?.latitude !== undefined &&
          c1?.longitude !== null &&
          c1?.longitude !== undefined
            ? `${c1.latitude}, ${c1.longitude}`
            : c1?.googleMapsUrl || '',
        'Visiting Time in Clinic 1': c1?.rawScheduleText || '',
        'location GPS 2':
          c2?.latitude !== null &&
          c2?.latitude !== undefined &&
          c2?.longitude !== null &&
          c2?.longitude !== undefined
            ? `${c2.latitude}, ${c2.longitude}`
            : c2?.googleMapsUrl || '',
        'Visiting Time in Clinic 2': c2?.rawScheduleText || '',
        'Quarterly Target': h.quarterlyTarget,
        'Baseline Visits': h.importedBaselineVisits,
        Notes: h.notes || '',
      };
    });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Territory_Rx_Export');
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `TerritoryRx_Export_${stamp}.xlsx`);
}
