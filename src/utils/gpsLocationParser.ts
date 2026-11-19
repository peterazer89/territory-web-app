import { Clinic, GeocodingStatus } from '../types/territory';

export interface GpsExtractionResult {
  latitude: number | null;
  longitude: number | null;
  isGoogleMapsUrl: boolean;
  googleMapsUrl: string;
  geocodingStatus: GeocodingStatus;
  usedZoneCentroid?: boolean;
}

export interface ZoneCentroidEntry {
  id: string;
  label: string;
  region: 'West Alexandria & North Coast' | 'West Cairo & Giza' | 'Greater Cairo';
  latitude: number;
  longitude: number;
  aliases: string[];
}

const ARABIC_AND_PERSIAN_DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/**
 * Exact Egyptian Zone Centroid lookup table matching Territory Rx Android
 * (30 West Alexandria & North Coast zones + 13 West Cairo / Giza / Greater Cairo zones).
 */
export const EGYPT_ZONE_CENTROIDS: ZoneCentroidEntry[] = [
  // --- West Alexandria & North Coast (30 entries) ---
  {
    id: 'amreya',
    label: 'العامرية (Amreya)',
    region: 'West Alexandria & North Coast',
    latitude: 31.0167,
    longitude: 29.7833,
    aliases: ['العامرية', 'العامريه', 'عامرية', 'عامريه', 'amreya', 'el amreya', 'ameriya', 'amriya', 'alamreya'],
  },
  {
    id: 'abdel_qader',
    label: 'عبد القادر (Abdel Qader)',
    region: 'West Alexandria & North Coast',
    latitude: 31.0285,
    longitude: 29.8120,
    aliases: ['عبد القادر', 'عبدالقادر', 'abdel qader', 'abd el qader', 'abdelkader', 'abdel kader'],
  },
  {
    id: 'king_mariout',
    label: 'كينج مريوط (King Mariout)',
    region: 'West Alexandria & North Coast',
    latitude: 31.0040,
    longitude: 29.7490,
    aliases: ['كينج مريوط', 'الكينج', 'مريوط', 'king mariout', 'king maryout', 'mariout', 'el king'],
  },
  {
    id: 'hawaria',
    label: 'الهوارية (El Hawaria)',
    region: 'West Alexandria & North Coast',
    latitude: 30.9850,
    longitude: 29.7250,
    aliases: ['الهوارية', 'الهواريه', 'هوارية', 'hawaria', 'el hawaria', 'hawariya'],
  },
  {
    id: 'new_borg_el_arab',
    label: 'برج العرب الجديدة (New Borg El Arab)',
    region: 'West Alexandria & North Coast',
    latitude: 30.8810,
    longitude: 29.5740,
    aliases: ['برج العرب الجديدة', 'برج العرب الجديده', 'new borg el arab', 'new burj al arab'],
  },
  {
    id: 'borg_el_arab',
    label: 'برج العرب (Borg El Arab)',
    region: 'West Alexandria & North Coast',
    latitude: 30.9167,
    longitude: 29.5500,
    aliases: ['برج العرب', 'borg el arab', 'burj al arab', 'borg al arab', 'bourg el arab'],
  },
  {
    id: 'bahig',
    label: 'بهيج (Bahig)',
    region: 'West Alexandria & North Coast',
    latitude: 30.9310,
    longitude: 29.6050,
    aliases: ['بهيج', 'bahig', 'baheeg', 'bahij'],
  },
  {
    id: 'gharbaniyat',
    label: 'الغربانيات (El Gharbaniyat)',
    region: 'West Alexandria & North Coast',
    latitude: 30.9550,
    longitude: 29.5200,
    aliases: ['الغربانيات', 'غربانيات', 'gharbaniyat', 'el gharbaniyat'],
  },
  {
    id: 'kilo_21',
    label: 'الكيلو 21 (Kilo 21)',
    region: 'West Alexandria & North Coast',
    latitude: 31.0785,
    longitude: 29.7310,
    aliases: ['الكيلو 21', 'كيلو 21', 'الكيلو ٢١', 'كيلو ٢١', 'kilo 21', 'km 21', 'k21'],
  },
  {
    id: 'abu_youssef',
    label: 'أبو يوسف (Abu Youssef)',
    region: 'West Alexandria & North Coast',
    latitude: 31.0890,
    longitude: 29.7485,
    aliases: ['أبو يوسف', 'ابو يوسف', 'ابويوسف', 'أبويوسف', 'abu youssef', 'abou youssef', 'abo youssef'],
  },
  {
    id: 'hanoville',
    label: 'الهانوفيل (Hanoville)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1045,
    longitude: 29.7715,
    aliases: ['الهانوفيل', 'هانوفيل', 'hanoville', 'el hanoville', 'hannoville', 'hanovil'],
  },
  {
    id: 'bitash',
    label: 'البيطاش (El Bitash)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1258,
    longitude: 29.7975,
    aliases: ['البيطاش', 'بيطاش', 'bitash', 'el bitash', 'betash', 'beitash'],
  },
  {
    id: 'agami',
    label: 'العجمي (El Agami)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1135,
    longitude: 29.7890,
    aliases: ['العجمي', 'العجمى', 'عجمي', 'عجمى', 'agami', 'el agami', 'agamy', 'el agamy'],
  },
  {
    id: 'dekheila',
    label: 'الدخيلة (El Dekheila)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1390,
    longitude: 29.8165,
    aliases: ['الدخيلة', 'الدخيله', 'دخيلة', 'dekheila', 'el dekheila', 'dekhela', 'el dekhela'],
  },
  {
    id: 'el_max',
    label: 'المكس (El Max)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1535,
    longitude: 29.8450,
    aliases: ['المكس', 'مكس', 'el max', 'el mex', 'mex'],
  },
  {
    id: 'wardian',
    label: 'الورديان (El Wardian)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1680,
    longitude: 29.8650,
    aliases: ['الورديان', 'ورديان', 'wardian', 'el wardian', 'wardyan'],
  },
  {
    id: 'gabbary',
    label: 'القباري (El Gabbary)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1810,
    longitude: 29.8805,
    aliases: ['القباري', 'القبارى', 'قباري', 'gabbary', 'el gabbary', 'qabbari', 'qabari'],
  },
  {
    id: 'mina_el_basal',
    label: 'مينا البصل (Mina El Basal)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1865,
    longitude: 29.8870,
    aliases: ['مينا البصل', 'ميناء البصل', 'mina el basal', 'mina al basal'],
  },
  {
    id: 'karmouz',
    label: 'كرموز (Karmouz)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1840,
    longitude: 29.8980,
    aliases: ['كرموز', 'karmouz', 'karmous', 'karmooz'],
  },
  {
    id: 'moharam_bek',
    label: 'محرم بك (Moharam Bek)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1905,
    longitude: 29.9140,
    aliases: ['محرم بك', 'محرم بيك', 'moharam bek', 'moharram bek', 'moharram bey', 'moharam bey'],
  },
  {
    id: 'bahary',
    label: 'بحري / الأنفوشي (Bahary)',
    region: 'West Alexandria & North Coast',
    latitude: 31.2090,
    longitude: 29.8840,
    aliases: ['بحري', 'بحرى', 'الأنفوشي', 'الانفوشي', 'الانفوشى', 'bahary', 'bahari', 'anfoushi', 'anfoushy'],
  },
  {
    id: 'gomrok',
    label: 'الجمرك (El Gomrok)',
    region: 'West Alexandria & North Coast',
    latitude: 31.2025,
    longitude: 29.8875,
    aliases: ['الجمرك', 'جمرك', 'gomrok', 'el gomrok', 'gumruk'],
  },
  {
    id: 'mansheya',
    label: 'المنشية (El Mansheya)',
    region: 'West Alexandria & North Coast',
    latitude: 31.1992,
    longitude: 29.8942,
    aliases: ['المنشية', 'المنشيه', 'منشية', 'mansheya', 'el mansheya', 'manshiya'],
  },
  {
    id: 'mahatet_el_raml',
    label: 'محطة الرمل (Mahatet El Raml)',
    region: 'West Alexandria & North Coast',
    latitude: 31.2008,
    longitude: 29.9005,
    aliases: ['محطة الرمل', 'محطه الرمل', 'الرمل', 'mahatet el raml', 'raml station', 'el raml'],
  },
  {
    id: 'azarita',
    label: 'الأزاريطة / المواساة (Azarita)',
    region: 'West Alexandria & North Coast',
    latitude: 31.2045,
    longitude: 29.9125,
    aliases: ['الأزاريطة', 'الازاريطة', 'الازاريطه', 'المواساة', 'المواساه', 'azarita', 'el mowasat', 'mowasat'],
  },
  {
    id: 'ibrahimia',
    label: 'الإبراهيمية / كامب شيزار (Ibrahimia)',
    region: 'West Alexandria & North Coast',
    latitude: 31.2115,
    longitude: 29.9270,
    aliases: ['الإبراهيمية', 'الابراهيمية', 'الابراهيميه', 'كامب شيزار', 'ibrahimia', 'ibrahimeya', 'camp caesar'],
  },
  {
    id: 'smouha',
    label: 'سموحة (Smouha)',
    region: 'West Alexandria & North Coast',
    latitude: 31.2156,
    longitude: 29.9420,
    aliases: ['سموحة', 'سموحه', 'smouha', 'semouha', 'smoha'],
  },
  {
    id: 'sidi_gaber',
    label: 'سيدي جابر (Sidi Gaber)',
    region: 'West Alexandria & North Coast',
    latitude: 31.2195,
    longitude: 29.9415,
    aliases: ['سيدي جابر', 'سيدى جابر', 'sidi gaber', 'sidi jaber'],
  },
  {
    id: 'sidi_kerir',
    label: 'سيدي كرير / الساحل الشمالي (Sidi Kerir)',
    region: 'West Alexandria & North Coast',
    latitude: 31.0290,
    longitude: 29.6600,
    aliases: ['سيدي كرير', 'سيدى كرير', 'الساحل الشمالي', 'الساحل الشمالى', 'الساحل', 'sidi kerir', 'sidi kreir', 'north coast', 'sahel'],
  },
  {
    id: 'el_hamam',
    label: 'الحمام / العلمين / مطروح (El Hamam)',
    region: 'West Alexandria & North Coast',
    latitude: 30.8440,
    longitude: 29.3940,
    aliases: ['الحمام', 'العلمين', 'مطروح', 'مرسى مطروح', 'el hamam', 'hammam', 'alamein', 'el alamein', 'matrouh', 'marsa matrouh'],
  },

  // --- West Cairo / Giza & Greater Cairo (13 entries) ---
  {
    id: 'sheikh_zayed',
    label: 'الشيخ زايد (Sheikh Zayed)',
    region: 'West Cairo & Giza',
    latitude: 30.0444,
    longitude: 30.9820,
    aliases: ['الشيخ زايد', 'شيخ زايد', 'زايد', 'sheikh zayed', 'el sheikh zayed', 'zayed'],
  },
  {
    id: 'october_6',
    label: '6 أكتوبر (6th of October)',
    region: 'West Cairo & Giza',
    latitude: 29.9723,
    longitude: 30.9420,
    aliases: ['6 أكتوبر', '6 اكتوبر', '٦ أكتوبر', '٦ اكتوبر', 'السادس من أكتوبر', 'اكتوبر', 'أكتوبر', '6th of october', '6 october', 'october'],
  },
  {
    id: 'hadayek_october',
    label: 'حدائق أكتوبر (Hadayek October)',
    region: 'West Cairo & Giza',
    latitude: 29.9280,
    longitude: 31.0150,
    aliases: ['حدائق أكتوبر', 'حدائق اكتوبر', 'hadayek october', 'october gardens'],
  },
  {
    id: 'hadayek_ahram',
    label: 'حدائق الأهرام (Hadayek Al Ahram)',
    region: 'West Cairo & Giza',
    latitude: 29.9740,
    longitude: 31.1060,
    aliases: ['حدائق الأهرام', 'حدائق الاهرام', 'hadayek al ahram', 'hadayek el ahram', 'pyramids gardens'],
  },
  {
    id: 'mohandessin',
    label: 'المهندسين (Mohandessin)',
    region: 'West Cairo & Giza',
    latitude: 30.0561,
    longitude: 31.2001,
    aliases: ['المهندسين', 'مهندسين', 'mohandessin', 'mohandeseen', 'el mohandessin'],
  },
  {
    id: 'dokki',
    label: 'الدقي (Dokki)',
    region: 'West Cairo & Giza',
    latitude: 30.0385,
    longitude: 31.2121,
    aliases: ['الدقي', 'الدقى', 'دقي', 'dokki', 'el dokki', 'doqqi'],
  },
  {
    id: 'agouza',
    label: 'العجوزة (Agouza)',
    region: 'West Cairo & Giza',
    latitude: 30.0530,
    longitude: 31.2105,
    aliases: ['العجوزة', 'العجوزه', 'عجوزة', 'agouza', 'el agouza', 'agoza'],
  },
  {
    id: 'zamalek',
    label: 'الزمالك (Zamalek)',
    region: 'Greater Cairo',
    latitude: 30.0609,
    longitude: 31.2197,
    aliases: ['الزمالك', 'زمالك', 'zamalek', 'el zamalek'],
  },
  {
    id: 'giza',
    label: 'الجيزة (Giza)',
    region: 'West Cairo & Giza',
    latitude: 30.0131,
    longitude: 31.2089,
    aliases: ['الجيزة', 'الجيزه', 'جيزة', 'giza', 'el giza'],
  },
  {
    id: 'haram_faisal',
    label: 'الهرم / فيصل (Haram & Faisal)',
    region: 'West Cairo & Giza',
    latitude: 29.9950,
    longitude: 31.1630,
    aliases: ['الهرم', 'هرم', 'فيصل', 'haram', 'el haram', 'faisal', 'pyramids'],
  },
  {
    id: 'maadi',
    label: 'المعادي (Maadi)',
    region: 'Greater Cairo',
    latitude: 29.9602,
    longitude: 31.2569,
    aliases: ['المعادي', 'المعادى', 'معادي', 'maadi', 'el maadi', 'degla'],
  },
  {
    id: 'nasr_city',
    label: 'مدينة نصر (Nasr City)',
    region: 'Greater Cairo',
    latitude: 30.0561,
    longitude: 31.3301,
    aliases: ['مدينة نصر', 'مدينه نصر', 'nasr city', 'madinet nasr'],
  },
  {
    id: 'heliopolis',
    label: 'مصر الجديدة (Heliopolis)',
    region: 'Greater Cairo',
    latitude: 30.0910,
    longitude: 31.3225,
    aliases: ['مصر الجديدة', 'مصر الجديده', 'هليوبوليس', 'التجمع', 'heliopolis', 'masr el gedida', 'new cairo'],
  },
];

// Default Territory Rx fallback hub (West Alexandria) when zone is unrecognized
const DEFAULT_FALLBACK_HUB = { latitude: 31.1150, longitude: 29.8250 };

export function isValidLatLng(
  lat: number | null | undefined,
  lng: number | null | undefined
): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Normalizes Arabic-Indic & Persian digits to ASCII, converts Arabic punctuation,
 * and decodes common Google Maps URL escape sequences.
 */
export function normalizeDigitsAndUrlText(raw: string): string {
  if (!raw) return '';
  let text = String(raw)
    .replace(/[\u00A0\u200B-\u200F\u202A-\u202E\uFEFF]/g, ' ')
    .replace(/[٠-٩۰-۹]/g, (ch) => ARABIC_AND_PERSIAN_DIGITS[ch] ?? ch)
    .replace(/[،؛]/g, ',');

  // Decode standard coordinate/DMS URL escapes safely
  text = text
    .replace(/%2C/gi, ',')
    .replace(/%20/gi, ' ')
    .replace(/%C2%B0/gi, '°')
    .replace(/%B0/gi, '°')
    .replace(/%27/gi, "'")
    .replace(/%22/gi, '"')
    .replace(/%2B/gi, '+')
    .replace(/%3A/gi, ':')
    .replace(/%2F/gi, '/');

  return text.trim();
}

/**
 * Splits a cell that holds multiple clinic location references (e.g. two URLs or two coordinate pairs
 * separated by "-", "|", ";", newlines, or spaces).
 */
export function splitLocationReferences(rawLocationCell: string): string[] {
  const normalized = normalizeDigitsAndUrlText(rawLocationCell);
  if (!normalized) return [];

  // 1. If the cell contains multiple http(s) URLs, extract each URL cleanly (commas ARE valid in Google Maps URLs!)
  const urls = normalized.match(/https?:\/\/[^\s;|]+/gi);
  if (urls && urls.length >= 2) {
    return urls.map((u) => u.replace(/[),;.\]]+$/, '').trim()).filter(Boolean);
  }

  // 2. If separated by explicit multi-ref delimiters (newline, pipe, semicolon, or " - " before a URL/coord)
  const parts = normalized
    .split(/(?:[\r\n]+|\s*\|\s*|\s*;\s*|\s+[-–—]\s+(?=https?:\/\/|-?\d{1,2}\.\d{3,}|\d{1,2}\s*[°º]))/i)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return parts;
  }

  return [normalized];
}

function normalizeZoneLookup(text: string): string {
  return normalizeDigitsAndUrlText(text)
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deterministicHash(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Resolves an Egyptian zone/brick name to its deterministic centroid,
 * applying a tiny bounded hash offset (~±200m) when seedText is provided
 * so distinct shortened links in the same brick don't stack at exact 0m.
 */
export function resolveZoneCentroid(
  zoneHint: string,
  seedText = ''
): { latitude: number; longitude: number; matchedEntry: ZoneCentroidEntry | null } {
  const normHint = normalizeZoneLookup(zoneHint);
  let matched: ZoneCentroidEntry | null = null;

  if (normHint) {
    // Prefer longest alias match so "برج العرب الجديدة" beats "برج العرب" and "الكيلو 21" beats "العجمي"
    let bestAliasLen = 0;
    for (const entry of EGYPT_ZONE_CENTROIDS) {
      for (const alias of entry.aliases) {
        const normAlias = normalizeZoneLookup(alias);
        if (!normAlias) continue;
        if (normHint.includes(normAlias) && normAlias.length > bestAliasLen) {
          bestAliasLen = normAlias.length;
          matched = entry;
        }
      }
    }
  }

  const baseLat = matched ? matched.latitude : DEFAULT_FALLBACK_HUB.latitude;
  const baseLng = matched ? matched.longitude : DEFAULT_FALLBACK_HUB.longitude;

  if (!seedText) {
    return {
      latitude: Number(baseLat.toFixed(6)),
      longitude: Number(baseLng.toFixed(6)),
      matchedEntry: matched,
    };
  }

  const h1 = deterministicHash(seedText);
  const h2 = deterministicHash(`${seedText}#lng`);
  // Bounded ±0.0020 degrees (~±220m max)
  const dLat = ((h1 % 4001) - 2000) / 1_000_000;
  const dLng = ((h2 % 4001) - 2000) / 1_000_000;

  return {
    latitude: Number((baseLat + dLat).toFixed(6)),
    longitude: Number((baseLng + dLng).toFixed(6)),
    matchedEntry: matched,
  };
}

function extractFirstUrl(raw: string): string {
  const match = raw.match(/https?:\/\/[^\s;|]+/i);
  if (match) {
    return match[0].replace(/[),;.\]]+$/, '');
  }
  const bareMatch = raw.match(
    /(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.[a-z.]+|www\.google\.[a-z.]+\/maps|google\.[a-z.]+\/maps|g\.page)\/[^\s;|)]*/i
  );
  if (bareMatch) {
    return `https://${bareMatch[0].replace(/[),;.\]]+$/, '')}`;
  }
  return '';
}

function isGoogleMapsLink(url: string, text: string): boolean {
  const target = `${url} ${text}`;
  return /(?:google\.[a-z.]+\/maps|maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps|g\.page)/i.test(
    target
  );
}

function isShortenedGoogleMapsUrl(url: string): boolean {
  return /(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.page\/r\/|g\.page\/)/i.test(url);
}

/**
 * Full 1-to-1 port of Android Territory Rx GPS Location Parser.
 * Supports Patterns 1-5:
 *  1. Google Maps data pins (!3dLAT!4dLNG and !2dLNG!3dLAT)
 *  2. Google Maps @lat,lng & query/path params (q=, ll=, query=, center=, daddr=, saddr=, destination=, place/, search/, =loc:)
 *  3. DMS coordinates (e.g. 31°07'25.2"N 29°46'55.8"E, Arabic or English digits)
 *  4. Plain decimal coordinate pairs (e.g. 31.123456, 29.876543 or Arabic digits)
 *  5. Shortened Google Maps URLs (maps.app.goo.gl / goo.gl/maps) via Egyptian zone centroid + deterministic hash offset
 */
export function extractCoordinates(
  rawLocation: string,
  zoneHint = '',
  rowSeed = ''
): GpsExtractionResult {
  const rawTrimmed = String(rawLocation || '').trim();
  if (!rawTrimmed) {
    return {
      latitude: null,
      longitude: null,
      isGoogleMapsUrl: false,
      googleMapsUrl: '',
      geocodingStatus: 'MISSING',
    };
  }

  // Exact "Unverified" guard
  if (/^unverified$/i.test(rawTrimmed)) {
    return {
      latitude: null,
      longitude: null,
      isGoogleMapsUrl: false,
      googleMapsUrl: '',
      geocodingStatus: 'UNVERIFIED',
    };
  }

  const googleMapsUrl = extractFirstUrl(rawTrimmed);
  const isGmaps = isGoogleMapsLink(googleMapsUrl, rawTrimmed);
  const normalized = normalizeDigitsAndUrlText(rawTrimmed);

  // Pattern 1a: !3dLAT!4dLNG
  const p1a = normalized.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (p1a) {
    const lat = parseFloat(p1a[1]);
    const lng = parseFloat(p1a[2]);
    if (isValidLatLng(lat, lng)) {
      return {
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lng.toFixed(6)),
        isGoogleMapsUrl: isGmaps,
        googleMapsUrl,
        geocodingStatus: isGmaps ? 'EXTRACTED_URL' : 'VERIFIED',
      };
    }
  }

  // Pattern 1b: !2dLNG!3dLAT (note: !2d is longitude, !3d is latitude)
  const p1b = normalized.match(/!2d(-?\d{1,3}\.\d+)!3d(-?\d{1,2}\.\d+)/);
  if (p1b) {
    const lng = parseFloat(p1b[1]);
    const lat = parseFloat(p1b[2]);
    if (isValidLatLng(lat, lng)) {
      return {
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lng.toFixed(6)),
        isGoogleMapsUrl: isGmaps,
        googleMapsUrl,
        geocodingStatus: isGmaps ? 'EXTRACTED_URL' : 'VERIFIED',
      };
    }
  }

  // Pattern 2: @lat,lng & Google Maps query/path parameters
  const p2 = normalized.match(
    /(?:@|[?&/](?:q|ll|query|center|daddr|saddr|destination|place|search)(?:=loc:|[:=/]))\s*\+?(-?\d{1,2}\.\d+)\s*[,\s+]+\s*\+?(-?\d{1,3}\.\d+)/i
  );
  if (p2) {
    const lat = parseFloat(p2[1]);
    const lng = parseFloat(p2[2]);
    if (isValidLatLng(lat, lng)) {
      return {
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lng.toFixed(6)),
        isGoogleMapsUrl: isGmaps,
        googleMapsUrl,
        geocodingStatus: isGmaps ? 'EXTRACTED_URL' : 'VERIFIED',
      };
    }
  }

  // Pattern 3: DMS coordinates (e.g. 31°07'25.2"N 29°46'55.8"E)
  const p3 = normalized.match(
    /(\d{1,2})\s*[°º]\s*(\d{1,2})\s*['′’]\s*(\d{1,2}(?:\.\d+)?)\s*["″”]?\s*([NSns])\s*[,/\s+]+\s*(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['′’]\s*(\d{1,2}(?:\.\d+)?)\s*["″”]?\s*([EWew])/
  );
  if (p3) {
    const latDeg = parseFloat(p3[1]);
    const latMin = parseFloat(p3[2]);
    const latSec = parseFloat(p3[3]);
    const latDir = p3[4].toUpperCase();
    const lngDeg = parseFloat(p3[5]);
    const lngMin = parseFloat(p3[6]);
    const lngSec = parseFloat(p3[7]);
    const lngDir = p3[8].toUpperCase();

    const lat = (latDeg + latMin / 60 + latSec / 3600) * (latDir === 'S' ? -1 : 1);
    const lng = (lngDeg + lngMin / 60 + lngSec / 3600) * (lngDir === 'W' ? -1 : 1);

    if (isValidLatLng(lat, lng)) {
      return {
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lng.toFixed(6)),
        isGoogleMapsUrl: isGmaps,
        googleMapsUrl,
        geocodingStatus: isGmaps ? 'EXTRACTED_URL' : 'VERIFIED',
      };
    }
  }

  // Pattern 4: Plain decimal coordinate pair (requires >= 3 decimal digits to avoid matching times/dates)
  const p4 = normalized.match(
    /(?<!\d)(-?\d{1,2}\.\d{3,})\s*(?:,|\/|\s+)\s*(-?\d{1,3}\.\d{3,})(?!\d)/
  );
  if (p4) {
    const lat = parseFloat(p4[1]);
    const lng = parseFloat(p4[2]);
    if (isValidLatLng(lat, lng)) {
      return {
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lng.toFixed(6)),
        isGoogleMapsUrl: isGmaps,
        googleMapsUrl,
        geocodingStatus: isGmaps ? 'EXTRACTED_URL' : 'VERIFIED',
      };
    }
  }

  // Pattern 5: Shortened Google Maps URLs (maps.app.goo.gl / goo.gl/maps / g.page)
  if (googleMapsUrl && isShortenedGoogleMapsUrl(googleMapsUrl)) {
    const effectiveZone = zoneHint.trim() || rawTrimmed;
    const seed = `${zoneHint.trim().toLowerCase()}|${googleMapsUrl || rawTrimmed || rowSeed}`;
    const resolved = resolveZoneCentroid(effectiveZone, seed);
    return {
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      isGoogleMapsUrl: true,
      googleMapsUrl,
      geocodingStatus: 'EXTRACTED_URL',
      usedZoneCentroid: true,
    };
  }

  return {
    latitude: null,
    longitude: null,
    isGoogleMapsUrl: isGmaps,
    googleMapsUrl,
    geocodingStatus: 'UNVERIFIED',
  };
}

/**
 * Resolves effective routable GPS coordinates for any clinic (including cloud-synced clinics
 * whose latitude/longitude were previously null or UNVERIFIED despite having a Google Maps URL).
 */
export function getEffectiveClinicCoordinates(clinic: Pick<
  Clinic,
  'clinicKey' | 'zone' | 'latitude' | 'longitude' | 'googleMapsUrl' | 'originalLocationText' | 'geocodingStatus'
>): {
  latitude: number | null;
  longitude: number | null;
  googleMapsUrl: string;
  geocodingStatus: GeocodingStatus;
  resolvedOnTheFly: boolean;
  isRoutable: boolean;
} {
  const existingUrl = (clinic.googleMapsUrl || '').trim();
  const existingOrig = (clinic.originalLocationText || '').trim();

  if (
    isValidLatLng(clinic.latitude, clinic.longitude) &&
    clinic.geocodingStatus !== 'UNVERIFIED'
  ) {
    const status: GeocodingStatus =
      clinic.geocodingStatus === 'VERIFIED' || clinic.geocodingStatus === 'EXTRACTED_URL'
        ? clinic.geocodingStatus
        : existingUrl.startsWith('http')
          ? 'EXTRACTED_URL'
          : 'VERIFIED';
    return {
      latitude: clinic.latitude,
      longitude: clinic.longitude,
      googleMapsUrl: existingUrl,
      geocodingStatus: status,
      resolvedOnTheFly: false,
      isRoutable: true,
    };
  }

  // Attempt on-the-fly resolution from googleMapsUrl or originalLocationText
  const candidates = [existingUrl, existingOrig].filter(Boolean);
  for (const cand of candidates) {
    const parsed = extractCoordinates(cand, clinic.zone || '', clinic.clinicKey || '');
    if (isValidLatLng(parsed.latitude, parsed.longitude)) {
      return {
        latitude: parsed.latitude,
        longitude: parsed.longitude,
        googleMapsUrl: parsed.googleMapsUrl || existingUrl,
        geocodingStatus: parsed.geocodingStatus,
        resolvedOnTheFly: true,
        isRoutable: true,
      };
    }
  }

  // If valid coordinates were stored even under UNVERIFIED status and text wasn't explicitly "Unverified"
  if (isValidLatLng(clinic.latitude, clinic.longitude) && !/^unverified$/i.test(existingOrig)) {
    return {
      latitude: clinic.latitude,
      longitude: clinic.longitude,
      googleMapsUrl: existingUrl,
      geocodingStatus: existingUrl.startsWith('http') ? 'EXTRACTED_URL' : 'VERIFIED',
      resolvedOnTheFly: true,
      isRoutable: true,
    };
  }

  return {
    latitude: null,
    longitude: null,
    googleMapsUrl: existingUrl,
    geocodingStatus: existingUrl || existingOrig ? 'UNVERIFIED' : 'MISSING',
    resolvedOnTheFly: false,
    isRoutable: false,
  };
}

/**
 * Builds the "Open Maps" href matching Territory Rx Android:
 * Prefers clinic.googleMapsUrl if present (crucial for exact maps.app.goo.gl pins),
 * otherwise falls back to https://www.google.com/maps/search/?api=1&query=${lat},${lng}.
 */
export function buildClinicOpenMapsUrl(clinic: {
  googleMapsUrl?: string;
  latitude: number | null;
  longitude: number | null;
}): string {
  const url = (clinic.googleMapsUrl || '').trim();
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  if (isValidLatLng(clinic.latitude, clinic.longitude)) {
    return `https://www.google.com/maps/search/?api=1&query=${clinic.latitude!.toFixed(6)},${clinic.longitude!.toFixed(6)}`;
  }
  return '';
}
