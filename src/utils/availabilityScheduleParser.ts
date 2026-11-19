import { Clinic, ClinicWindow, ScheduleParseStatus } from '../types/territory';

/**
 * ISO day of week numbering (1=Monday .. 7=Sunday), matching Android/Firestore.
 * Egyptian display order: Saturday (6) -> Friday (5).
 */
export const EGYPTIAN_DAY_ORDER = [6, 7, 1, 2, 3, 4, 5] as const;
export const ALL_ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export interface ParsedTimeWindow {
  dayOfWeek: number; // 1..7 (ISO: 1=Mon .. 7=Sun)
  startMinuteOfDay: number; // 0..1439
  endMinuteOfDay: number; // 0..1439
  endsNextDay: boolean;
  isConfirmed: boolean;
}

export interface ScheduleParseResult {
  rawText: string;
  windows: ParsedTimeWindow[];
  status: 'PARSED_HIGH_CONFIDENCE' | 'AMBIGUOUS' | 'UNPARSED' | 'CONFIRMED';
  ambiguityReason: string;
  normalizedDays: number[];
  excludedDays: number[];
}

const ISO_DAY_FULL_NAMES: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

const ISO_DAY_SHORT_NAMES: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

const EGYPT_ORDER_RANK: Record<number, number> = {
  6: 0,
  7: 1,
  1: 2,
  2: 3,
  3: 4,
  4: 5,
  5: 6,
};

export function sortIsoDaysEgyptian(days: number[]): number[] {
  return [...days].sort((a, b) => (EGYPT_ORDER_RANK[a] ?? 99) - (EGYPT_ORDER_RANK[b] ?? 99));
}

export function jsDayToIsoDay(jsDay: number): number {
  return jsDay === 0 ? 7 : jsDay;
}

export function formatMinutes12h(minuteOfDay: number): string {
  const norm = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  const h24 = Math.floor(norm / 60);
  const m = norm % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

const DAY_NAME_TO_ISO: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
};

function coerceIsoDay(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) {
    const n = Math.round(val);
    if (n >= 1 && n <= 7) return n;
    return null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^[1-7]$/.test(trimmed)) return parseInt(trimmed, 10);
    const mapped = DAY_NAME_TO_ISO[trimmed.toLowerCase()];
    if (mapped) return mapped;
  }
  return null;
}

function coerceMinuteOfDay(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) {
    const n = Math.round(val);
    if (n >= 0 && n <= 1440) return n === 1440 ? 1439 : n;
    return null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^\d{1,4}$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (n >= 0 && n <= 1440) return n === 1440 ? 1439 : n;
    }
    const hm = trimmed.match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
    if (hm) {
      let h = parseInt(hm[1], 10);
      const m = parseInt(hm[2], 10);
      const mer = hm[3]?.toUpperCase();
      if (mer === 'AM' && h === 12) h = 0;
      else if (mer === 'PM' && h < 12) h += 12;
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return h * 60 + m;
    }
  }
  return null;
}

/**
 * Defensively normalizes a ClinicWindow object from Firestore (supporting Android/Kotlin
 * serialization variants like `dayOfWeekIso`, `"SATURDAY"`, `startMinute`, `"16:00"`, etc.).
 */
export function normalizeClinicWindowFromUnknown(
  raw: unknown,
  defaultConfirmed = false
): ClinicWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const day = coerceIsoDay(
    obj.dayOfWeek ?? obj.dayOfWeekIso ?? obj.dayIso ?? obj.day ?? obj.isoDay
  );
  const start = coerceMinuteOfDay(
    obj.startMinuteOfDay ??
      obj.startMinute ??
      obj.startMinutes ??
      obj.startMin ??
      obj.openMinute ??
      obj.fromMinute ??
      obj.startTime
  );
  const end = coerceMinuteOfDay(
    obj.endMinuteOfDay ??
      obj.endMinute ??
      obj.endMinutes ??
      obj.endMin ??
      obj.closeMinute ??
      obj.toMinute ??
      obj.endTime
  );

  if (day === null || start === null || end === null) return null;

  return {
    dayOfWeek: day,
    startMinuteOfDay: start,
    endMinuteOfDay: end,
    endsNextDay: Boolean(obj.endsNextDay ?? obj.overnight ?? (end < start)),
    isConfirmed: Boolean(obj.isConfirmed ?? obj.confirmed ?? defaultConfirmed),
  };
}

export function normalizeClinicWindowsList(
  rawWindows: unknown,
  defaultConfirmed = false
): ClinicWindow[] {
  let list: unknown[] = [];
  if (Array.isArray(rawWindows)) {
    list = rawWindows;
  } else if (typeof rawWindows === 'string' && rawWindows.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(rawWindows);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
  }
  const out: ClinicWindow[] = [];
  for (const item of list) {
    const norm = normalizeClinicWindowFromUnknown(item, defaultConfirmed);
    if (norm) out.push(norm);
  }
  return out;
}

export function formatCleanScheduleGroups(
  windows: ParsedTimeWindow[] | ClinicWindow[]
): Array<{ days: string; daysShort: string; range: string; dayNumbers: number[] }> {
  if (!windows || windows.length === 0) return [];

  const byRange = new Map<string, number[]>();
  for (const w of windows) {
    const range = `${formatMinutes12h(w.startMinuteOfDay)} – ${formatMinutes12h(w.endMinuteOfDay)}${
      w.endsNextDay ? ' (+1d)' : ''
    }`;
    const list = byRange.get(range) || [];
    if (!list.includes(w.dayOfWeek)) list.push(w.dayOfWeek);
    byRange.set(range, list);
  }

  return Array.from(byRange.entries())
    .map(([range, days]) => {
      const ordered = sortIsoDaysEgyptian(days);
      const isEveryDay = ordered.length === 7;
      return {
        days: isEveryDay
          ? 'Every Day'
          : ordered.map((d) => ISO_DAY_FULL_NAMES[d] || `Day ${d}`).join(', '),
        daysShort: isEveryDay
          ? 'Daily'
          : ordered.map((d) => ISO_DAY_SHORT_NAMES[d] || `D${d}`).join(', '),
        range,
        dayNumbers: ordered,
      };
    })
    .sort(
      (a, b) =>
        (EGYPT_ORDER_RANK[a.dayNumbers[0]] ?? 99) - (EGYPT_ORDER_RANK[b.dayNumbers[0]] ?? 99)
    );
}

export function formatCleanScheduleSingleLine(
  windows: ParsedTimeWindow[] | ClinicWindow[],
  useShortDays = true
): string {
  const groups = formatCleanScheduleGroups(windows);
  if (groups.length === 0) return '';
  return groups
    .map((g) => `${useShortDays ? g.daysShort : g.days}: ${g.range}`)
    .join(' | ');
}

function convertDigitsToAscii(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x0660 && code <= 0x0669) {
      out += String(code - 0x0660);
    } else if (code >= 0x06f0 && code <= 0x06f9) {
      out += String(code - 0x06f0);
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * Step A: Exact normalization for English + Arabic clinic schedule text.
 */
export function normalizeTextForTimeParsing(raw: string): string {
  if (!raw) return '';
  let s = convertDigitsToAscii(raw);

  // 2. Strip invisible RTL/zero-width marks, NBSP, and Arabic diacritics
  s = s
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/،/g, ',')
    .replace(/؛/g, ';')
    .replace(/[–—−]/g, '-');

  // 3. Normalize comma-minutes (e.g. 8,30 -> 8:30)
  s = s.replace(/(\d{1,2}),(00|15|30|45)(?!\d)/g, '$1:$2');

  // 5. Written Arabic hour words BEFORE fractional words (careful NOT to replace الاثنين/اتنين Monday!)
  const writtenHours: Array<[RegExp, string]> = [
    [/(?:الساعة|الساعه)?\s*(?:الثانية\s*عشر[ةه]?|الثانيه\s*عشر[ةه]?|ثانية\s*عشر[ةه]?|اتناشر|اثنا\s*عشر)/g, ' 12 '],
    [/(?:الساعة|الساعه)?\s*(?:الحادية\s*عشر[ةه]?|الحاديه\s*عشر[ةه]?|حداشر|احدى\s*عشر)/g, ' 11 '],
    [/(?:الساعة|الساعه)?\s*(?:العاشرة|العاشره|عشرة|عشره)/g, ' 10 '],
    [/(?:الساعة|الساعه)?\s*(?:التاسعة|التاسعه|تاسعة|تسعة|تسعه)/g, ' 9 '],
    [/(?:الساعة|الساعه)?\s*(?:الثامنة|الثامنه|ثامنة|تمانية|تمانيه|ثمانية|ثمانيه)/g, ' 8 '],
    [/(?:الساعة|الساعه)?\s*(?:السابعة|السابعه|سابعة|سبعة|سبعه)/g, ' 7 '],
    [/(?:الساعة|الساعه)?\s*(?:السادسة|السادسه|سادسة|ستة|سته)/g, ' 6 '],
    [/(?:الساعة|الساعه)?\s*(?:الخامسة|الخامسه|خامسة|خمسة|خمسه)/g, ' 5 '],
    [/(?:الساعة|الساعه)?\s*(?:الرابعة|الرابعه|رابعة|أربعة|اربعة|اربعه|أربعه)/g, ' 4 '],
    [/(?:الساعة|الساعه)?\s*(?:الثالثة|الثالثه|ثالثة|تلاتة|تلاته|ثلاثة|ثلاثه)/g, ' 3 '],
    [/(?:الساعة|الساعه)\s*(?:الثانية|الثانيه|اتنين|اثنين)|(?:الثانية|الثانيه|ثانية)(?!\s*عشر)/g, ' 2 '],
    [/(?:الساعة|الساعه)?\s*(?:الواحدة|الواحده|واحدة|واحده)/g, ' 1 '],
  ];
  for (const [pat, repl] of writtenHours) {
    s = s.replace(pat, repl);
  }

  // 4. Arabic fractional words
  s = s.replace(/(\d{1,2})\s*(?:ونصف|ونص)/g, '$1:30');
  s = s.replace(/(\d{1,2})\s*وربع/g, '$1:15');
  s = s.replace(/(\d{1,2})\s*(?:إلا|الا)\s*ربع/g, (_m, hStr: string) => {
    const h = parseInt(hStr, 10);
    if (!Number.isFinite(h)) return `${hStr}:45`;
    const prevH = h <= 1 ? 12 : h - 1;
    return `${prevH}:45`;
  });
  s = s.replace(/ونصف|ونص/g, ':30');
  s = s.replace(/وربع/g, ':15');
  s = s.replace(/إلا\s*ربع|الا\s*ربع/g, ':45');

  // 6. Arabic AM/PM words & short suffixes BEFORE converting "ل"
  s = s.replace(/في\s*الصباح|صباحا|صباح|الصبح/g, ' AM ');
  s = s.replace(/بعد\s*الظهر|الظهر|ظهرا|بعد\s*العصر|العصر|عصرا/g, ' PM ');
  s = s.replace(/في\s*المساء|مساءا|مساء|ليلا|بالليل|العشاء|عشاء|المغرب|مغربا|مغرب/g, ' PM ');
  s = s.replace(/(\d)\s*ص(?![\p{L}])/gu, '$1 AM ');
  s = s.replace(/(\d)\s*(?:م|ظ|ع)(?![\p{L}])/gu, '$1 PM ');

  // 7. Arabic connectors
  s = s.replace(/بعد\s*الساعة|بعد\s*الساعه|بعد/g, ' after ');
  s = s.replace(/من\s*الساعة|من\s*الساعه|الساعة|الساعه|ابتداء\s*من|بداية\s*من|من|بين/g, ' from ');
  s = s.replace(/إلى|الى|الي|حتى|حتي|وحتى|وحتي|لغاية|لغايه|لحد/g, ' to ');
  s = s.replace(/((?:\d|AM|PM)\s*)(?:لـ|ل)(\s*\d)/gi, '$1 to $2');
  s = s.replace(/\b(between|from)\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s+و\s+(\d{1,2})/gi, '$1 $2 and $3');

  // 8. Normalize "3 or 4 : 6 PM" / "3 or 4 - 6 PM" -> first hour for start, second for end
  s = s.replace(
    /(\d{1,2}(?::\d{2})?)\s+or\s+\d{1,2}(?::\d{2})?\s*([:\-;]|to)\s*(\d{1,2})/gi,
    '$1 $2 $3'
  );

  // Collapse extra horizontal whitespace while preserving newlines / pipes / semicolons
  s = s.replace(/[ \t]+/g, ' ').trim();
  return s;
}

// Weekday patterns (English full, abbrev, typos, Arabic variants)
const ENGLISH_DAY_PATTERNS: Array<{ iso: number; regex: RegExp }> = [
  { iso: 1, regex: /\b(?:mondays?|mon\.?|monda|moday)\b/gi },
  { iso: 2, regex: /\b(?:tuesdays?|tusedays?|teusdays?|tues\.?|tue\.?|tus\.?)\b/gi },
  { iso: 3, regex: /\b(?:wednesdays?|wensdays?|wednsdays?|wednesdy|weds\.?|wed\.?)\b/gi },
  { iso: 4, regex: /\b(?:thursdays?|thrusdays?|thurdays?|thurs\.?|thur\.?|thu\.?|ths\.?)\b/gi },
  { iso: 5, regex: /\b(?:fridays?|fridy|fri\.?)\b/gi },
  { iso: 6, regex: /\b(?:saturdays?|saturdy|satrday|sat\.?)\b/gi },
  { iso: 7, regex: /\b(?:sundays?|sundy|sun\.?)\b/gi },
];

// Arabic day tokens allowing optional prefixes و / ل / لل / من / ب / وال / لل
const ARABIC_DAY_PATTERNS: Array<{ iso: number; regex: RegExp }> = [
  { iso: 6, regex: /(?:^|[^\p{L}])((?:و|ل|لل|ب)?(?:ال)?سبت)(?=$|[^\p{L}])/gu },
  { iso: 7, regex: /(?:^|[^\p{L}])((?:و|ل|لل|ب)?(?:الأحد|الاحد|الحد|أحد|احد|حد))(?=$|[^\p{L}])/gu },
  { iso: 1, regex: /(?:^|[^\p{L}])((?:و|ل|لل|ب)?(?:الإثنين|الاثنين|الاتنين|إثنين|اثنين|اتنين))(?=$|[^\p{L}])/gu },
  { iso: 2, regex: /(?:^|[^\p{L}])((?:و|ل|لل|ب)?(?:الثلاثاء|الثلاث|التلاتاء|التلات|ثلاثاء|تلات))(?=$|[^\p{L}])/gu },
  { iso: 3, regex: /(?:^|[^\p{L}])((?:و|ل|لل|ب)?(?:الأربعاء|الاربعاء|الأربع|الاربع|أربعاء|اربعاء|اربع))(?=$|[^\p{L}])/gu },
  { iso: 4, regex: /(?:^|[^\p{L}])((?:و|ل|لل|ب)?(?:ال)?خميس)(?=$|[^\p{L}])/gu },
  { iso: 5, regex: /(?:^|[^\p{L}])((?:و|ل|لل|ب)?(?:ال)?جمع[ةه])(?=$|[^\p{L}])/gu },
];

const DAILY_REGEX =
  /\b(?:daily|everyday|every\s*day|all\s*days|all\s*week|7\s*days|whole\s*week)\b|يوميا|كل\s*يوم|طوال\s*الاسبوع|طوال\s*الأسبوع|جميع\s*الايام|جميع\s*الأيام/i;

const EXCLUSION_REGEX =
  /\b(?:except|excluding|exc\.?|but\s+not|other\s+than|closed\s+on|off\s+on)\b|ما\s*عدا|ماعدا|عدا|غير|اجازة|إجازة|أجازة/i;

const BOOKING_AMBIGUOUS_REGEX =
  /\b(?:by\s*appointment|appointment\s*only|call\s*first|call\s*before|call\s*to|phone\s*only|booking\s*only|book\s*first|reserve\s*first)\b|بالحجز|حسب\s*الحجز|حجز\s*مسبق|بالميعاد|اتصال|تليفون|بالتليفون/i;

const TENTATIVE_AMBIGUOUS_REGEX =
  /\b(?:unconfirmed|maybe|tentative|tbd|not\s*sure|pending|varies|upon\s*request)\b|غير\s*مؤكد|ربما|متغير/i;

const APPROX_AMBIGUOUS_REGEX = /\b(?:around|approx\.?|approximately|about)\b|~|حوالي|تقريبا/i;

const EVENING_CONTEXT_REGEX = /\b(?:evening|night|afternoon|pm|p\.m\.)\b|مساء|ظهر|عصر|مغرب|ليل/i;
const MORNING_CONTEXT_REGEX = /\b(?:morning|am|a\.m\.)\b|صباح|الصبح/i;

interface DayHit {
  iso: number;
  start: number;
  end: number;
  raw: string;
  hasArabicToPrefix: boolean;
}

function findDayHits(text: string): DayHit[] {
  const hits: DayHit[] = [];

  for (const pat of ENGLISH_DAY_PATTERNS) {
    const r = new RegExp(pat.regex.source, pat.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(text)) !== null) {
      hits.push({
        iso: pat.iso,
        start: m.index,
        end: m.index + m[0].length,
        raw: m[0],
        hasArabicToPrefix: false,
      });
    }
  }

  for (const pat of ARABIC_DAY_PATTERNS) {
    const r = new RegExp(pat.regex.source, pat.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(text)) !== null) {
      const token = m[1];
      const offsetInMatch = m[0].indexOf(token);
      const start = m.index + Math.max(0, offsetInMatch);
      hits.push({
        iso: pat.iso,
        start,
        end: start + token.length,
        raw: token,
        hasArabicToPrefix: /^لل|^ل(?:ال)?/.test(token),
      });
    }
  }

  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped: DayHit[] = [];
  for (const h of hits) {
    const prev = deduped[deduped.length - 1];
    if (!prev || h.start >= prev.end) {
      deduped.push(h);
    }
  }
  return deduped;
}

function expandIsoDayRange(startIso: number, endIso: number): number[] {
  const res: number[] = [];
  let cur = startIso;
  for (let i = 0; i < 7; i++) {
    res.push(cur);
    if (cur === endIso) break;
    cur = cur === 7 ? 1 : cur + 1;
  }
  return res;
}

interface ExtractedDaysInfo {
  days: number[];
  excluded: number[];
  hasExplicitDays: boolean;
  isDaily: boolean;
}

function extractDaysFromSlice(text: string): ExtractedDaysInfo {
  const isDaily = DAILY_REGEX.test(text);
  const exclMatch = text.match(EXCLUSION_REGEX);

  let mainPart = text;
  let excludedPart = '';
  if (exclMatch && exclMatch.index !== undefined) {
    mainPart = text.slice(0, exclMatch.index);
    excludedPart = text.slice(exclMatch.index + exclMatch[0].length);
  }

  const excludedHits = findDayHits(excludedPart);
  const excluded = Array.from(new Set(excludedHits.map((h) => h.iso)));

  const mainHits = findDayHits(mainPart);
  let daysSet = new Set<number>();

  if (mainHits.length > 0) {
    // Check if there is a 3+ discrete hyphen/slash day list (e.g. "Sun - Tue - Thu", "Sat / Mon / Wed")
    let allDiscreteChain = false;
    if (mainHits.length >= 3) {
      let sepCount = 0;
      for (let i = 0; i < mainHits.length - 1; i++) {
        const between = mainPart.slice(mainHits[i].end, mainHits[i + 1].start).trim();
        if (/^[-/\\]$/.test(between)) sepCount++;
      }
      if (sepCount === mainHits.length - 1) {
        allDiscreteChain = true;
      }
    }

    if (allDiscreteChain) {
      for (const h of mainHits) daysSet.add(h.iso);
    } else {
      for (let i = 0; i < mainHits.length; i++) {
        const cur = mainHits[i];
        const next = mainHits[i + 1];
        if (next) {
          const between = mainPart.slice(cur.end, next.start).trim();
          const isExplicitRangeConnector =
            /^(?:-|to|till|until|thru|through|حتى|الى|إلى)$/i.test(between) ||
            (between === '' && next.hasArabicToPrefix);

          // Avoid treating 3+ chain of hyphens as a range
          const nextAfter = mainHits[i + 2];
          const nextBetween = nextAfter ? mainPart.slice(next.end, nextAfter.start).trim() : '';
          const partOf3PlusHyphenList =
            between === '-' && (nextBetween === '-' || nextBetween === '/');

          if (isExplicitRangeConnector && !partOf3PlusHyphenList) {
            for (const d of expandIsoDayRange(cur.iso, next.iso)) {
              daysSet.add(d);
            }
            i++;
            continue;
          }
        }
        daysSet.add(cur.iso);
      }
    }
  }

  const hasExplicitDays = daysSet.size > 0;
  if (!hasExplicitDays && (isDaily || excluded.length > 0)) {
    daysSet = new Set(ALL_ISO_DAYS);
  }

  for (const ex of excluded) {
    daysSet.delete(ex);
  }

  return {
    days: sortIsoDaysEgyptian(Array.from(daysSet)),
    excluded: sortIsoDaysEgyptian(excluded),
    hasExplicitDays,
    isDaily,
  };
}

function parseMeridiem(raw: string | undefined): 'AM' | 'PM' | null {
  if (!raw) return null;
  const clean = raw.replace(/\./g, '').trim().toUpperCase();
  if (clean === 'AM') return 'AM';
  if (clean === 'PM') return 'PM';
  return null;
}

interface RawTimeRangeMatch {
  startIdx: number;
  endIdx: number;
  h1: number;
  m1: number;
  mer1: 'AM' | 'PM' | null;
  h2: number;
  m2: number;
  mer2: 'AM' | 'PM' | null;
  tier: string;
}

interface SingleTimeMatch {
  startIdx: number;
  endIdx: number;
  raw: string;
}

function isSpanFree(occupied: boolean[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (occupied[i]) return false;
  }
  return true;
}

function markSpan(occupied: boolean[], start: number, end: number): void {
  for (let i = start; i < end; i++) {
    occupied[i] = true;
  }
}

/**
 * Step D: 6-Tier Time Range Extraction with char-span occupancy guard.
 */
function extractTimeMatches(segment: string): {
  ranges: RawTimeRangeMatch[];
  singles: SingleTimeMatch[];
} {
  const occupied = new Array<boolean>(segment.length).fill(false);
  const ranges: RawTimeRangeMatch[] = [];
  const singles: SingleTimeMatch[] = [];

  const addRange = (
    startIdx: number,
    endIdx: number,
    h1: number,
    m1: number,
    mer1: 'AM' | 'PM' | null,
    h2: number,
    m2: number,
    mer2: 'AM' | 'PM' | null,
    tier: string
  ) => {
    if (h1 < 0 || h1 > 23 || h2 < 0 || h2 > 24 || m1 < 0 || m1 > 59 || m2 < 0 || m2 > 59) return;
    if (!isSpanFree(occupied, startIdx, endIdx)) return;
    markSpan(occupied, startIdx, endIdx);
    ranges.push({ startIdx, endIdx, h1, m1, mer1, h2, m2, mer2, tier });
  };

  // Tier 1: Explicit connectors (-, –, —, to, until, till, thru, through, /, \, _, ..)
  const tier1 =
    /(?<!\d)(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:to|until|till|thru|through|[-–—~/\\_]+|\.{2,})\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/gi;
  let m: RegExpExecArray | null;
  while ((m = tier1.exec(segment)) !== null) {
    const h1 = parseInt(m[1], 10);
    const m1 = m[2] ? parseInt(m[2], 10) : 0;
    const mer1 = parseMeridiem(m[3]);
    const h2 = parseInt(m[4], 10);
    const m2 = m[5] ? parseInt(m[5], 10) : 0;
    const mer2 = parseMeridiem(m[6]);
    // Guard against dates like 19/11 or 2026-11
    if (!mer1 && !mer2 && !m[2] && !m[5] && m[0].includes('/') && (h1 > 23 || h2 > 23)) continue;
    addRange(m.index, m.index + m[0].length, h1, m1, mer1, h2, m2, mer2, 'T1');
  }

  // Tier 1b: "from/between H1 and/&/to H2"
  const tier1b =
    /\b(?:from|between)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:and|&|to)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/gi;
  while ((m = tier1b.exec(segment)) !== null) {
    addRange(
      m.index,
      m.index + m[0].length,
      parseInt(m[1], 10),
      m[2] ? parseInt(m[2], 10) : 0,
      parseMeridiem(m[3]),
      parseInt(m[4], 10),
      m[5] ? parseInt(m[5], 10) : 0,
      parseMeridiem(m[6]),
      'T1b'
    );
  }

  // Tier 2: Colon/semicolon range with explicit start AM/PM ("4 PM : 7 PM", "4:30 PM : 7:30 PM")
  const tier2 =
    /(?<!\d)(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\s*[:;]\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/gi;
  while ((m = tier2.exec(segment)) !== null) {
    addRange(
      m.index,
      m.index + m[0].length,
      parseInt(m[1], 10),
      m[2] ? parseInt(m[2], 10) : 0,
      parseMeridiem(m[3]),
      parseInt(m[4], 10),
      m[5] ? parseInt(m[5], 10) : 0,
      parseMeridiem(m[6]),
      'T2'
    );
  }

  // Tier 3a: Colon/semicolon range where start has minutes ("4:30 : 7:30 PM", "16:00 : 19:00")
  const tier3a =
    /(?<!\d)(\d{1,2}):(\d{2})\s*[:;]\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/gi;
  while ((m = tier3a.exec(segment)) !== null) {
    addRange(
      m.index,
      m.index + m[0].length,
      parseInt(m[1], 10),
      parseInt(m[2], 10),
      null,
      parseInt(m[3], 10),
      m[4] ? parseInt(m[4], 10) : 0,
      parseMeridiem(m[5]),
      'T3a'
    );
  }

  // Tier 3b: Colon/semicolon range where end has minutes ("4 : 7:30 PM")
  const tier3b =
    /(?<!\d)(\d{1,2})\s*[:;]\s*(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/gi;
  while ((m = tier3b.exec(segment)) !== null) {
    addRange(
      m.index,
      m.index + m[0].length,
      parseInt(m[1], 10),
      0,
      null,
      parseInt(m[2], 10),
      parseInt(m[3], 10),
      parseMeridiem(m[4]),
      'T3b'
    );
  }

  // Tier 4: Hour-colon-hour shorthand ("4:7 PM", "4 : 7 PM", "8:10 PM", "4:7", "4 ; 7 PM")
  const tier4 = /(?<!\d)(\d{1,2})(\s*[:;.]\s*)(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/gi;
  while ((m = tier4.exec(segment)) !== null) {
    const startIdx = m.index;
    const endIdx = m.index + m[0].length;
    if (!isSpanFree(occupied, startIdx, endIdx)) continue;

    const h1Str = m[1];
    const sep = m[2];
    const h2Str = m[3];
    const mer2 = parseMeridiem(m[4]);

    const h1 = parseInt(h1Str, 10);
    const h2 = parseInt(h2Str, 10);
    const hasSpaces = /\s/.test(sep);
    const isDot = sep.includes('.');
    const isSemicolon = sep.includes(';');

    // Never treat "8.30" or "5:30" or "8:05" as hour-to-hour range
    if (isDot && !hasSpaces && h2Str.length === 2) continue;
    if (h2Str.length === 2 && h2Str.startsWith('0')) continue; // e.g. 8:00 or 8:05 is minutes

    const isHourToHour =
      hasSpaces ||
      isSemicolon ||
      (h2Str.length === 1 && h2 >= 1 && h2 <= 9) ||
      (h1 >= 1 && h1 <= 12 && h2 >= 1 && h2 <= 12 && h2 !== h1);

    if (isHourToHour && h1 >= 1 && h1 <= 23 && h2 >= 1 && h2 <= 24) {
      addRange(startIdx, endIdx, h1, 0, null, h2, 0, mer2, 'T4');
    }
  }

  // Tier 6: Bare pair of numbers with weekday/shift context ("Sat 5 8", "Saturday 2 6 PM")
  const hasContext =
    findDayHits(segment).length > 0 ||
    DAILY_REGEX.test(segment) ||
    EVENING_CONTEXT_REGEX.test(segment) ||
    MORNING_CONTEXT_REGEX.test(segment);
  if (hasContext) {
    const tier6Pair = /(?<!\d)(\d{1,2})\s+(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)?(?!\d)/gi;
    while ((m = tier6Pair.exec(segment)) !== null) {
      const startIdx = m.index;
      const endIdx = m.index + m[0].length;
      if (!isSpanFree(occupied, startIdx, endIdx)) continue;
      const h1 = parseInt(m[1], 10);
      const h2 = parseInt(m[2], 10);
      if (h1 >= 1 && h1 <= 12 && h2 >= 1 && h2 <= 12 && h1 !== h2) {
        addRange(startIdx, endIdx, h1, 0, null, h2, 0, parseMeridiem(m[3]), 'T6');
      }
    }
  }

  // Tier 5 & 6 single clock times ("5 PM", "from 4", "16:00", "Saturday 5:30") -> AMBIGUOUS (needs end time)
  const tier5Single =
    /(?:\b(?:from|after|at)\s+)?(?<!\d)(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?!\d)|\b(?:from|after|at)\s+(\d{1,2})(?::(\d{2}))?(?!\d)|(?<!\d)(\d{1,2}):(\d{2})(?!\d)/gi;
  while ((m = tier5Single.exec(segment)) !== null) {
    const startIdx = m.index;
    const endIdx = m.index + m[0].length;
    if (!isSpanFree(occupied, startIdx, endIdx)) continue;
    markSpan(occupied, startIdx, endIdx);
    singles.push({ startIdx, endIdx, raw: m[0].trim() });
  }

  ranges.sort((a, b) => a.startIdx - b.startIdx);
  return { ranges, singles };
}

function to24hMinute(hour: number, minute: number, meridiem: 'AM' | 'PM' | null): number {
  let h = hour;
  if (h === 24 && minute === 0) return 1439;
  if (meridiem === 'AM') {
    if (h === 12) h = 0;
  } else if (meridiem === 'PM') {
    if (h < 12) h += 12;
  }
  return Math.max(0, Math.min(1439, h * 60 + minute));
}

interface ResolvedTimeRange {
  startMinute: number;
  endMinute: number;
  endsNextDay: boolean;
  ambiguous: boolean;
  reason: string;
}

/**
 * Step E: Egyptian AM/PM inference & overnight rules.
 */
function resolveEgyptianTimeRange(
  match: RawTimeRangeMatch,
  contextText: string,
  hasExplicitDays: boolean
): ResolvedTimeRange {
  const { h1, m1, h2, m2 } = match;
  let mer1 = match.mer1;
  let mer2 = match.mer2;

  const is24hStart = h1 === 0 || h1 >= 13;
  const is24hEnd = h2 === 0 || h2 >= 13;

  // Special case: "8 PM - 12 AM" -> ends at 23:59 (1439)
  if (mer1 === 'PM' && mer2 === 'AM' && h2 === 12 && m2 === 0) {
    return {
      startMinute: to24hMinute(h1, m1, 'PM'),
      endMinute: 1439,
      endsNextDay: false,
      ambiguous: false,
      reason: '',
    };
  }

  if (is24hStart || is24hEnd) {
    const startMin = is24hStart ? h1 * 60 + m1 : to24hMinute(h1, m1, mer1 || (h1 <= 11 && h2 >= 13 ? 'PM' : null));
    const endMin = is24hEnd ? (h2 === 24 ? 1439 : h2 * 60 + m2) : to24hMinute(h2, m2, mer2);
    const endsNextDay = startMin >= 18 * 60 && endMin > 0 && endMin <= 6 * 60;
    if (startMin === endMin) {
      return { startMinute: startMin, endMinute: endMin, endsNextDay: false, ambiguous: true, reason: 'Start and end time are identical.' };
    }
    if (endMin < startMin && !endsNextDay) {
      return { startMinute: startMin, endMinute: endMin, endsNextDay: false, ambiguous: true, reason: 'End time is before start time.' };
    }
    return { startMinute: startMin, endMinute: endMin, endsNextDay, ambiguous: false, reason: '' };
  }

  // Both AM/PM missing
  if (!mer1 && !mer2) {
    const hasEveningCtx = EVENING_CONTEXT_REGEX.test(contextText);
    const hasMorningCtx = MORNING_CONTEXT_REGEX.test(contextText);

    if (h1 === 12 && h2 >= 1 && h2 <= 11) {
      mer1 = 'PM';
      mer2 = 'PM';
    } else if (h1 >= 8 && h1 <= 11 && h2 >= 1 && h2 <= 6) {
      mer1 = 'AM';
      mer2 = 'PM';
    } else if (hasEveningCtx && !hasMorningCtx) {
      mer1 = 'PM';
      mer2 = h2 === 12 ? 'AM' : 'PM';
    } else if (hasMorningCtx && !hasEveningCtx) {
      mer1 = 'AM';
      mer2 = h2 === 12 || h2 < h1 ? 'PM' : 'AM';
    } else {
      const isAmbiguousMorningOrEvening =
        h1 >= 7 && h1 <= 11 && h2 >= 8 && h2 <= 12 && h1 < h2;
      const isClearEgyptianAfternoon =
        h1 >= 1 && h1 <= 6 && ((h2 > h1 && h2 <= 12) || (h2 >= 1 && h2 <= 12 && h2 === 12));
      if ((hasExplicitDays || isClearEgyptianAfternoon) && !isAmbiguousMorningOrEvening) {
        mer1 = 'PM';
        mer2 = h2 === 12 ? 'AM' : 'PM';
      } else {
        return {
          startMinute: 0,
          endMinute: 0,
          endsNextDay: false,
          ambiguous: true,
          reason: `Missing AM/PM on "${h1}${m1 ? `:${String(m1).padStart(2, '0')}` : ''} - ${h2}${m2 ? `:${String(m2).padStart(2, '0')}` : ''}" — please confirm morning or evening.`,
        };
      }
    }
  } else if (!mer1 && mer2 === 'PM') {
    if (h1 === 12) {
      mer1 = 'PM';
    } else if (h1 >= 1 && h1 <= 11 && (h1 < h2 || (h1 === h2 && m1 < m2))) {
      mer1 = 'PM';
    } else if (h1 >= 8 && h1 <= 11 && h2 >= 1 && h2 <= 6) {
      mer1 = 'AM';
    } else if (h1 > h2 && h1 >= 7 && h1 <= 11) {
      mer1 = 'AM';
    } else {
      mer1 = 'PM';
    }
  } else if (!mer1 && mer2 === 'AM') {
    if (h1 >= 6 && h1 <= 11 && h2 >= 1 && h2 <= 6 && h1 > h2) {
      mer1 = 'PM';
    } else if (h2 === 12 && h1 >= 6 && h1 <= 11) {
      mer1 = 'PM';
    } else {
      mer1 = 'AM';
    }
  } else if (mer1 === 'AM' && !mer2) {
    mer2 = h2 < h1 || h2 === 12 ? 'PM' : 'AM';
  } else if (mer1 === 'PM' && !mer2) {
    if (h2 === 12) {
      mer2 = 'AM';
    } else if (h2 < h1 && h2 >= 1 && h2 <= 6) {
      mer2 = 'AM';
    } else {
      mer2 = 'PM';
    }
  }

  // Re-check midnight end (e.g. inferred 8 PM - 12 AM)
  if (mer1 === 'PM' && mer2 === 'AM' && h2 === 12 && m2 === 0) {
    return {
      startMinute: to24hMinute(h1, m1, 'PM'),
      endMinute: 1439,
      endsNextDay: false,
      ambiguous: false,
      reason: '',
    };
  }

  const startMinute = to24hMinute(h1, m1, mer1);
  const endMinute = to24hMinute(h2, m2, mer2);

  if (startMinute === endMinute) {
    return {
      startMinute,
      endMinute,
      endsNextDay: false,
      ambiguous: true,
      reason: 'Start and end time resolve to the same minute.',
    };
  }

  // Genuine overnight (e.g. 11 PM - 1 AM)
  if (startMinute >= 18 * 60 && endMinute >= 1 && endMinute <= 6 * 60 && mer2 === 'AM') {
    return {
      startMinute,
      endMinute,
      endsNextDay: true,
      ambiguous: false,
      reason: '',
    };
  }

  if (endMinute < startMinute) {
    return {
      startMinute,
      endMinute,
      endsNextDay: false,
      ambiguous: true,
      reason: 'End time falls earlier than start time.',
    };
  }

  return {
    startMinute,
    endMinute,
    endsNextDay: false,
    ambiguous: false,
    reason: '',
  };
}

/**
 * Step B: Segment splitting with adjacent days-only + times-only segment merging.
 */
export function splitIntoSegments(normalizedText: string): string[] {
  // Convert semicolons between digits first so "4 ; 7 PM" stays one time expression
  const prepped = normalizedText.replace(/(\d)\s*;\s*(\d)/g, '$1 : $2');
  const rawSegments = prepped
    .split(/[|;\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const merged: string[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const cur = rawSegments[i];
    const curHasDays = findDayHits(cur).length > 0 || DAILY_REGEX.test(cur);
    const curTimes = extractTimeMatches(cur);
    const curHasTime = curTimes.ranges.length > 0 || curTimes.singles.length > 0;

    if (curHasDays && !curHasTime && i + 1 < rawSegments.length) {
      const next = rawSegments[i + 1];
      const nextHasDays = findDayHits(next).length > 0 || DAILY_REGEX.test(next);
      const nextTimes = extractTimeMatches(next);
      const nextHasTime = nextTimes.ranges.length > 0 || nextTimes.singles.length > 0;

      if (!nextHasDays && nextHasTime) {
        merged.push(`${cur} ${next}`);
        i++;
        continue;
      }
    }

    if (!curHasDays && curHasTime && i + 1 < rawSegments.length) {
      const next = rawSegments[i + 1];
      const nextHasDays = findDayHits(next).length > 0 || DAILY_REGEX.test(next);
      const nextTimes = extractTimeMatches(next);
      const nextHasTime = nextTimes.ranges.length > 0 || nextTimes.singles.length > 0;

      if (nextHasDays && !nextHasTime) {
        merged.push(`${cur} ${next}`);
        i++;
        continue;
      }
    }

    merged.push(cur);
  }

  return merged;
}

/**
 * Deterministic 1-to-1 TypeScript port of Android Territory Rx `AvailabilityScheduleParser`.
 */
export function parseSchedule(rawText: string): ScheduleParseResult {
  const original = (rawText || '').trim();
  if (!original) {
    return {
      rawText: original,
      windows: [],
      status: 'UNPARSED',
      ambiguityReason: 'No schedule text provided.',
      normalizedDays: [],
      excludedDays: [],
    };
  }

  const normalized = normalizeTextForTimeParsing(original);
  const segments = splitIntoSegments(normalized);

  const ambiguityReasons: string[] = [];
  if (BOOKING_AMBIGUOUS_REGEX.test(normalized)) {
    ambiguityReasons.push('Mentions booking/call/appointment requirement.');
  }
  if (TENTATIVE_AMBIGUOUS_REGEX.test(normalized)) {
    ambiguityReasons.push('Contains tentative/unconfirmed wording.');
  }
  if (APPROX_AMBIGUOUS_REGEX.test(normalized)) {
    ambiguityReasons.push('Contains approximate time wording.');
  }

  interface ClauseOutput {
    days: number[];
    excluded: number[];
    isDailyBase: boolean;
    hasExplicitDays: boolean;
    startMinute: number;
    endMinute: number;
    endsNextDay: boolean;
  }

  const allClauses: ClauseOutput[] = [];
  const allExcluded = new Set<number>();

  for (const segment of segments) {
    const { ranges, singles } = extractTimeMatches(segment);

    if (ranges.length === 0) {
      if (singles.length > 0) {
        ambiguityReasons.push(
          `Single time "${singles[0].raw}" detected without an end time — please confirm range.`
        );
      }
      // Still capture any excluded days mentioned
      const dInfo = extractDaysFromSlice(segment);
      dInfo.excluded.forEach((d) => allExcluded.add(d));
      continue;
    }

    if (singles.length > 0) {
      ambiguityReasons.push(
        `Additional single time "${singles[0].raw}" without end time needs review.`
      );
    }

    const segmentClauses: ClauseOutput[] = [];

    if (ranges.length === 1) {
      const r = ranges[0];
      const textWithoutRange =
        segment.slice(0, r.startIdx) + ' ' + segment.slice(r.endIdx);
      const dayInfo = extractDaysFromSlice(textWithoutRange);
      dayInfo.excluded.forEach((d) => allExcluded.add(d));

      let targetDays = dayInfo.days;
      const isDailyBase = !dayInfo.hasExplicitDays;
      if (targetDays.length === 0 && !dayInfo.hasExplicitDays && dayInfo.excluded.length === 0) {
        targetDays = [...EGYPTIAN_DAY_ORDER];
      }

      const resolved = resolveEgyptianTimeRange(
        r,
        segment,
        dayInfo.hasExplicitDays || dayInfo.isDaily
      );
      if (resolved.ambiguous) {
        ambiguityReasons.push(resolved.reason);
      } else {
        segmentClauses.push({
          days: targetDays,
          excluded: dayInfo.excluded,
          isDailyBase,
          hasExplicitDays: dayInfo.hasExplicitDays,
          startMinute: resolved.startMinute,
          endMinute: resolved.endMinute,
          endsNextDay: resolved.endsNextDay,
        });
      }
    } else {
      // Multi-range segment (e.g., "Daily 8 PM-10 PM, Friday 5 PM-7 PM" or "Sat-Mon 2-5 PM, Tue-Thu 6-9 PM")
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        const prevEnd = i === 0 ? 0 : ranges[i - 1].endIdx;
        const nextStart = i + 1 < ranges.length ? ranges[i + 1].startIdx : segment.length;

        const leadingSlice = segment.slice(prevEnd, r.startIdx);
        const trailingSlice = segment.slice(r.endIdx, nextStart);

        const leadingInfo = extractDaysFromSlice(leadingSlice);
        const trailingInfo = extractDaysFromSlice(trailingSlice);

        const leadingHasInfo =
          leadingInfo.hasExplicitDays || leadingInfo.isDaily || leadingInfo.excluded.length > 0;
        const trailingHasInfo =
          trailingInfo.hasExplicitDays || trailingInfo.isDaily || trailingInfo.excluded.length > 0;

        let chosenInfo: ExtractedDaysInfo;
        let ctxSlice = leadingSlice + ' ' + segment.slice(r.startIdx, r.endIdx);

        if (leadingHasInfo) {
          chosenInfo = leadingInfo;
          // If exclusion appears right after the time range (e.g. "Daily 8-10 PM except Friday, ..."),
          // only consume trailing exclusions if they occur before a comma/override day
          if (
            trailingInfo.excluded.length > 0 &&
            !trailingInfo.hasExplicitDays &&
            !trailingInfo.isDaily
          ) {
            const mergedExcl = Array.from(
              new Set([...leadingInfo.excluded, ...trailingInfo.excluded])
            );
            chosenInfo = {
              ...leadingInfo,
              excluded: mergedExcl,
              days: leadingInfo.days.filter((d) => !mergedExcl.includes(d)),
            };
          }
        } else if (trailingHasInfo && i === ranges.length - 1) {
          chosenInfo = trailingInfo;
          ctxSlice = segment.slice(r.startIdx, r.endIdx) + ' ' + trailingSlice;
        } else if (trailingHasInfo && !leadingHasInfo && i === 0) {
          // e.g. "8-10 PM Sat, 5-7 PM Fri" -> bind trailing days if next range has no leading days?
          // Split trailingSlice on comma to keep before-comma attached to this range
          const beforeComma = trailingSlice.split(',')[0] || '';
          const bcInfo = extractDaysFromSlice(beforeComma);
          if (bcInfo.hasExplicitDays || bcInfo.isDaily || bcInfo.excluded.length > 0) {
            chosenInfo = bcInfo;
            ctxSlice = segment.slice(r.startIdx, r.endIdx) + ' ' + beforeComma;
          } else {
            chosenInfo = leadingInfo;
          }
        } else {
          chosenInfo = leadingInfo;
        }

        chosenInfo.excluded.forEach((d) => allExcluded.add(d));
        let targetDays = chosenInfo.days;
        const isDailyBase = !chosenInfo.hasExplicitDays;
        if (
          targetDays.length === 0 &&
          !chosenInfo.hasExplicitDays &&
          chosenInfo.excluded.length === 0
        ) {
          targetDays = [...EGYPTIAN_DAY_ORDER];
        }

        const resolved = resolveEgyptianTimeRange(
          r,
          ctxSlice,
          chosenInfo.hasExplicitDays || chosenInfo.isDaily
        );
        if (resolved.ambiguous) {
          ambiguityReasons.push(resolved.reason);
        } else {
          segmentClauses.push({
            days: targetDays,
            excluded: chosenInfo.excluded,
            isDailyBase,
            hasExplicitDays: chosenInfo.hasExplicitDays,
            startMinute: resolved.startMinute,
            endMinute: resolved.endMinute,
            endsNextDay: resolved.endsNextDay,
          });
        }
      }

      // Daily + Override clause handling (e.g. "Daily 8 PM-10 PM, Friday 5 PM-7 PM"):
      // Explicit-day override clauses subtract their days from any daily-base clause in the same segment.
      const overrideDays = new Set<number>();
      for (const cl of segmentClauses) {
        if (cl.hasExplicitDays && !cl.isDailyBase) {
          cl.days.forEach((d) => overrideDays.add(d));
        }
      }
      if (overrideDays.size > 0) {
        for (const cl of segmentClauses) {
          if (cl.isDailyBase) {
            cl.days = cl.days.filter((d) => !overrideDays.has(d));
          }
        }
      }
    }

    allClauses.push(...segmentClauses);
  }

  // Also apply cross-segment Daily + Override if one segment is Daily and another is an explicit single/subset override
  const hasAnyDailyClause = allClauses.some((c) => c.isDailyBase);
  const explicitOverrideDays = new Set<number>();
  if (hasAnyDailyClause) {
    for (const c of allClauses) {
      if (c.hasExplicitDays && !c.isDailyBase) {
        c.days.forEach((d) => explicitOverrideDays.add(d));
      }
    }
    if (explicitOverrideDays.size > 0 && explicitOverrideDays.size < 7) {
      for (const c of allClauses) {
        if (c.isDailyBase) {
          c.days = c.days.filter((d) => !explicitOverrideDays.has(d));
        }
      }
    }
  }

  // Materialize & deduplicate windows
  const uniqueMap = new Map<string, ParsedTimeWindow>();
  for (const cl of allClauses) {
    for (const day of cl.days) {
      const key = `${day}_${cl.startMinute}_${cl.endMinute}_${cl.endsNextDay ? 1 : 0}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, {
          dayOfWeek: day,
          startMinuteOfDay: cl.startMinute,
          endMinuteOfDay: cl.endMinute,
          endsNextDay: cl.endsNextDay,
          isConfirmed: false,
        });
      }
    }
  }

  const windows = Array.from(uniqueMap.values()).sort(
    (a, b) =>
      (EGYPT_ORDER_RANK[a.dayOfWeek] ?? 99) - (EGYPT_ORDER_RANK[b.dayOfWeek] ?? 99) ||
      a.startMinuteOfDay - b.startMinuteOfDay
  );

  const normalizedDays = sortIsoDaysEgyptian(
    Array.from(new Set(windows.map((w) => w.dayOfWeek)))
  );
  const excludedDays = sortIsoDaysEgyptian(Array.from(allExcluded));

  if (windows.length === 0) {
    const hasReason = ambiguityReasons.length > 0;
    return {
      rawText: original,
      windows: [],
      status: hasReason ? 'AMBIGUOUS' : 'UNPARSED',
      ambiguityReason:
        ambiguityReasons.join(' ') || 'Could not extract a valid visiting time range.',
      normalizedDays: [],
      excludedDays,
    };
  }

  if (ambiguityReasons.length > 0) {
    return {
      rawText: original,
      windows,
      status: 'AMBIGUOUS',
      ambiguityReason: ambiguityReasons.join(' '),
      normalizedDays,
      excludedDays,
    };
  }

  return {
    rawText: original,
    windows,
    status: 'PARSED_HIGH_CONFIDENCE',
    ambiguityReason: '',
    normalizedDays,
    excludedDays,
  };
}

/**
 * Classifies a ScheduleParseResult into Android's scheduleClassification tag.
 */
export function classifyScheduleResult(result: ScheduleParseResult): string {
  if (result.windows.length === 0) {
    return result.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'UNPARSED';
  }
  if (result.windows.some((w) => w.endsNextDay)) return 'OVERNIGHT';
  if (result.excludedDays.length > 0) return 'DAILY_EXCEPT';
  const distinctRanges = new Set(
    result.windows.map((w) => `${w.startMinuteOfDay}-${w.endMinuteOfDay}`)
  );
  if (distinctRanges.size > 1) return 'MULTIPLE_WINDOWS';
  if (result.normalizedDays.length === 7) return 'DAILY_DEFAULT';
  return 'EXPLICIT_DAYS';
}

const EMBEDDED_SCHEDULE_CUE_REGEX =
  /\b(?:am|pm|a\.m\.|p\.m\.|daily|everyday|every\s*day|sat|sun|mon|tue|wed|thu|fri|saturday|sunday|monday|tuesday|wednesday|thursday|friday)\b|صباح|مساء|ظهر|عصر|يوميا|كل\s*يوم|السبت|الاحد|الأحد|الاثنين|الإثنين|الثلاثاء|الاربعاء|الأربعاء|الخميس|الجمعة/i;

/**
 * Returns true if a location/combined cell appears to embed visiting hours text
 * (not merely GPS coordinates or street numbers like "الكيلو 21").
 */
export function looksLikeEmbeddedScheduleText(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t) && !/\s/.test(t)) return false;
  return EMBEDDED_SCHEDULE_CUE_REGEX.test(t);
}

/**
 * Returns effective windows for a clinic: uses normalized stored `clinic.windows` when populated,
 * otherwise parses `rawScheduleText` / `originalExcelScheduleText` (or embedded schedule in
 * `originalLocationText` if it contains explicit schedule cues) on the fly in memory.
 */
export function getEffectiveClinicWindows(clinic: Clinic): {
  windows: ClinicWindow[];
  parsedOnTheFly: boolean;
  parseStatus: ScheduleParseStatus;
  ambiguityReason: string;
} {
  const normalizedStored = normalizeClinicWindowsList(
    clinic.windows,
    Boolean(clinic.isManualUserConfirmed || clinic.userConfirmedSchedule)
  );
  if (normalizedStored.length > 0) {
    return {
      windows: normalizedStored,
      parsedOnTheFly: false,
      parseStatus: clinic.scheduleParseStatus || 'PARSED_HIGH_CONFIDENCE',
      ambiguityReason: clinic.scheduleAmbiguityReason || '',
    };
  }

  let fallbackText = (clinic.rawScheduleText || clinic.originalExcelScheduleText || '').trim();
  if (!fallbackText && looksLikeEmbeddedScheduleText(clinic.originalLocationText || '')) {
    fallbackText = (clinic.originalLocationText || '').trim();
  }

  if (!fallbackText) {
    return {
      windows: [],
      parsedOnTheFly: false,
      parseStatus: clinic.scheduleParseStatus || 'UNPARSED',
      ambiguityReason: clinic.scheduleAmbiguityReason || '',
    };
  }

  const parsed = parseSchedule(fallbackText);
  return {
    windows: parsed.windows,
    parsedOnTheFly: parsed.windows.length > 0,
    parseStatus: parsed.status,
    ambiguityReason: parsed.ambiguityReason,
  };
}
