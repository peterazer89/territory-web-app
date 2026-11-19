import { GeocodingStatus } from '../types/territory';
import {
  buildClinicOpenMapsUrl,
  extractCoordinates,
  isValidLatLng,
  normalizeDigitsAndUrlText,
} from '../utils/gpsLocationParser';

export interface ExtractedGeo {
  latitude: number | null;
  longitude: number | null;
  googleMapsUrl: string;
  geocodingStatus: GeocodingStatus;
  isGoogleMapsUrl?: boolean;
  usedZoneCentroid?: boolean;
}

export function normalizeDigits(input: string): string {
  return normalizeDigitsAndUrlText(input);
}

export function isValidCoordinatePair(
  lat: number | null | undefined,
  lng: number | null | undefined
): boolean {
  return isValidLatLng(lat, lng);
}

/**
 * Extracts latitude/longitude from Google Maps URLs, DMS strings, shortened links, or plain coordinates.
 */
export function extractCoordinatesFromText(
  raw: string,
  zoneHint = '',
  rowSeed = ''
): ExtractedGeo {
  const parsed = extractCoordinates(raw, zoneHint, rowSeed);
  return {
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    googleMapsUrl: parsed.googleMapsUrl,
    geocodingStatus: parsed.geocodingStatus,
    isGoogleMapsUrl: parsed.isGoogleMapsUrl,
    usedZoneCentroid: parsed.usedZoneCentroid,
  };
}

export function buildGoogleMapsPinUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function buildGoogleMapsDirectionsUrl(
  destLat: number | null,
  destLng: number | null,
  preferredUrl?: string,
  fallbackText?: string
): string {
  const direct = buildClinicOpenMapsUrl({
    googleMapsUrl: preferredUrl,
    latitude: destLat,
    longitude: destLng,
  });
  if (direct) return direct;
  if (fallbackText && fallbackText.trim().length > 0) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallbackText.trim())}`;
  }
  return '';
}

/**
 * Builds a Google Maps multi-stop driving route URL for the full daily plan.
 */
export function buildMultiStopGoogleMapsUrl(
  stops: Array<{ latitude: number | null; longitude: number | null; hcpName: string; zone: string }>,
  homeLat?: number | null,
  homeLng?: number | null,
  returnHomeRequired = false
): string {
  const coords = stops
    .filter((s) => isValidCoordinatePair(s.latitude, s.longitude))
    .map((s) => `${s.latitude!.toFixed(6)},${s.longitude!.toFixed(6)}`);

  if (coords.length === 0) return '';

  const hasHome = isValidCoordinatePair(homeLat, homeLng);
  const homeCoord = hasHome ? `${homeLat!.toFixed(6)},${homeLng!.toFixed(6)}` : null;

  const origin = homeCoord || coords[0];
  const destination = returnHomeRequired && homeCoord ? homeCoord : coords[coords.length - 1];

  const waypointList = homeCoord
    ? returnHomeRequired
      ? coords
      : coords.slice(0, -1)
    : coords.slice(1, -1);

  const params = new URLSearchParams({
    api: '1',
    travelmode: 'driving',
    origin,
    destination,
  });

  if (waypointList.length > 0) {
    params.set('waypoints', waypointList.slice(0, 9).join('|'));
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Great-circle Haversine distance in kilometers.
 */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export interface TravelEstimate {
  distanceKm: number;
  travelMinutes: number;
  isSameBuilding: boolean;
}

/**
 * Computes road-adjusted driving distance and travel minutes with traffic safety buffer.
 * Clinics within 50 meters are treated as same-building (0 driving minutes, sequential visits).
 */
export function estimateTravel(
  fromLat: number | null | undefined,
  fromLng: number | null | undefined,
  toLat: number | null | undefined,
  toLng: number | null | undefined,
  trafficSafetyBufferPercent = 15
): TravelEstimate {
  if (!isValidCoordinatePair(fromLat, fromLng) || !isValidCoordinatePair(toLat, toLng)) {
    // Conservative urban fallback when one endpoint lacks GPS
    return { distanceKm: 3.5, travelMinutes: 14, isSameBuilding: false };
  }

  const straightKm = haversineKm(fromLat!, fromLng!, toLat!, toLng!);
  if (straightKm <= 0.05) {
    return { distanceKm: 0, travelMinutes: 0, isSameBuilding: true };
  }

  const roadKm = Number((straightKm * 1.32).toFixed(2));
  // Realistic metro urban average ~26 km/h + parking/traffic buffer
  const baseMinutes = (roadKm / 26) * 60;
  const bufferFactor = 1 + Math.max(0, trafficSafetyBufferPercent) / 100;
  const travelMinutes = Math.max(3, Math.ceil(baseMinutes * bufferFactor + 3));

  return {
    distanceKm: roadKm,
    travelMinutes,
    isSameBuilding: false,
  };
}
