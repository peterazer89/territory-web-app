import { ClinicWindow, ScheduleParseStatus } from '../types/territory';
import {
  classifyScheduleResult,
  parseSchedule,
} from '../utils/availabilityScheduleParser';

export interface DeterministicScheduleParseResult {
  windows: ClinicWindow[];
  normalizedDaysCsv: string;
  excludedDaysCsv: string;
  scheduleParseStatus: ScheduleParseStatus;
  scheduleClassification: string;
  parsingMethod: string;
  validationStatus: string;
  scheduleAmbiguityReason: string;
}

/**
 * Compatibility wrapper around `src/utils/availabilityScheduleParser.ts`
 * so every caller in the app uses the exact 1-to-1 Android AvailabilityScheduleParser.
 */
export function parseClinicScheduleDeterministic(rawText: string): DeterministicScheduleParseResult {
  const res = parseSchedule(rawText || '');
  const classification = classifyScheduleResult(res);
  const isValid =
    res.windows.length > 0 &&
    (res.status === 'PARSED_HIGH_CONFIDENCE' || res.status === 'CONFIRMED');

  return {
    windows: res.windows,
    normalizedDaysCsv: res.normalizedDays.join(','),
    excludedDaysCsv: res.excludedDays.join(','),
    scheduleParseStatus: res.status,
    scheduleClassification: classification,
    parsingMethod: 'DETERMINISTIC',
    validationStatus: isValid ? 'VALID' : 'NEEDS_REVIEW',
    scheduleAmbiguityReason: res.ambiguityReason,
  };
}
