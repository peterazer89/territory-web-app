export const ISO_DAYS: Array<{ iso: number; short: string; full: string; ar: string }> = [
  { iso: 1, short: 'Mon', full: 'Monday', ar: 'الاثنين' },
  { iso: 2, short: 'Tue', full: 'Tuesday', ar: 'الثلاثاء' },
  { iso: 3, short: 'Wed', full: 'Wednesday', ar: 'الأربعاء' },
  { iso: 4, short: 'Thu', full: 'Thursday', ar: 'الخميس' },
  { iso: 5, short: 'Fri', full: 'Friday', ar: 'الجمعة' },
  { iso: 6, short: 'Sat', full: 'Saturday', ar: 'السبت' },
  { iso: 7, short: 'Sun', full: 'Sunday', ar: 'الأحد' },
];

export function todayIso(): string {
  const d = new Date();
  return toDateIso(d);
}

export function toDateIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDateIso(dateIso: string): Date {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDaysIso(dateIso: string, delta: number): string {
  const d = parseDateIso(dateIso);
  d.setDate(d.getDate() + delta);
  return toDateIso(d);
}

/**
 * Returns ISO day of week: 1=Monday .. 7=Sunday (matches java.time.DayOfWeek used in Android).
 */
export function getIsoDayOfWeek(dateIso: string): number {
  const d = parseDateIso(dateIso);
  const jsDay = d.getDay(); // 0=Sun, 1=Mon .. 6=Sat
  return jsDay === 0 ? 7 : jsDay;
}

export function getIsoDayLabel(isoDay: number, format: 'short' | 'full' = 'short'): string {
  const found = ISO_DAYS.find((d) => d.iso === isoDay);
  if (!found) return `Day ${isoDay}`;
  return format === 'short' ? found.short : found.full;
}

/**
 * Calculates the calendar week bounds containing `dateIso` using `firstDayOfWeekIso` (1..7).
 */
export function getWeekBounds(dateIso: string, firstDayOfWeekIso = 6): {
  weekStartIso: string;
  weekEndIso: string;
  weekKey: string;
} {
  const currentIsoDay = getIsoDayOfWeek(dateIso);
  const normalizedStart = Math.max(1, Math.min(7, firstDayOfWeekIso || 6));
  const diff = (currentIsoDay - normalizedStart + 7) % 7;
  const weekStartIso = addDaysIso(dateIso, -diff);
  const weekEndIso = addDaysIso(weekStartIso, 6);
  return {
    weekStartIso,
    weekEndIso,
    weekKey: weekStartIso,
  };
}

export function getWeekDates(dateIso: string, firstDayOfWeekIso = 6): Array<{
  dateIso: string;
  isoDay: number;
  dayShort: string;
  dayNum: number;
}> {
  const { weekStartIso } = getWeekBounds(dateIso, firstDayOfWeekIso);
  return Array.from({ length: 7 }, (_, i) => {
    const dIso = addDaysIso(weekStartIso, i);
    const isoDay = getIsoDayOfWeek(dIso);
    const parsed = parseDateIso(dIso);
    return {
      dateIso: dIso,
      isoDay,
      dayShort: getIsoDayLabel(isoDay, 'short'),
      dayNum: parsed.getDate(),
    };
  });
}

export function getQuarterLabel(dateIso?: string): string {
  const d = dateIso ? parseDateIso(dateIso) : new Date();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

export function formatMinuteOfDay(minutes: number, use24h = false): string {
  const norm = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h24 = Math.floor(norm / 60);
  const m = norm % 60;
  const mStr = String(m).padStart(2, '0');
  if (use24h) {
    return `${String(h24).padStart(2, '0')}:${mStr}`;
  }
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mStr} ${suffix}`;
}

export function formatDuration(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function parseTimeInputToMinutes(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return Math.max(0, Math.min(1439, h * 60 + m));
}

export function minutesToTimeInput(minutes: number): string {
  const norm = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatReadableDate(dateIso: string): string {
  const d = parseDateIso(dateIso);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function daysBetweenIso(fromIso: string, toIso: string): number {
  const a = parseDateIso(fromIso).getTime();
  const b = parseDateIso(toIso).getTime();
  return Math.round((b - a) / 86400000);
}
