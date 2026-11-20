import React, { useMemo, useState } from 'react';
import {
  Car,
  Check,
  Clock,
  ExternalLink,
  Home,
  Maximize2,
  Minimize2,
  Minus,
  Navigation,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { Clinic, DailyPlan, PlanStop } from '../types/territory';
import { formatMinuteOfDay } from '../lib/dateUtils';
import {
  buildGoogleMapsDirectionsUrl,
  buildMultiStopGoogleMapsUrl,
} from '../lib/geoUtils';
import {
  getEffectiveClinicCoordinates,
  isValidLatLng,
  resolveZoneCentroid,
} from '../utils/gpsLocationParser';

interface RouteMapIllustrationProps {
  plan: DailyPlan;
  clinicsByKey: Map<string, Clinic>;
  homeLatitude: number | null;
  homeLongitude: number | null;
  homeAddress: string;
  returnHomeRequired: boolean;
}

interface ResolvedRouteNode {
  id: string;
  kind: 'HOME_START' | 'STOP' | 'HOME_END';
  orderNumber: number;
  title: string;
  subtitle: string;
  zone: string;
  latitude: number;
  longitude: number;
  timeWindowLabel: string;
  distanceKmFromPrev: number;
  travelMinutesFromPrev: number;
  executionStatus?: PlanStop['executionStatus'];
  stopRef?: PlanStop;
  singleStopMapsUrl?: string;
}

const SVG_W = 800;
const SVG_H = 440;
const PAD_X = 76;
const PAD_Y = 64;

function lngToWorldX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * 256 * Math.pow(2, zoom);
}

function latToWorldY(lat: number, zoom: number): number {
  const clampedLat = Math.max(-85, Math.min(85, lat));
  const rad = (clampedLat * Math.PI) / 180;
  const mercN = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
  return ((1 - mercN / Math.PI) / 2) * 256 * Math.pow(2, zoom);
}

export const RouteMapIllustration: React.FC<RouteMapIllustrationProps> = ({
  plan,
  clinicsByKey,
  homeLatitude,
  homeLongitude,
  homeAddress,
  returnHomeRequired,
}) => {
  const [selectedNodeIdx, setSelectedNodeIdx] = useState<number | null>(null);
  const [zoomDelta, setZoomDelta] = useState<number>(0);
  const [expanded, setExpanded] = useState<boolean>(false);

  // Resolve coordinates for every stop in the route (falling back to clinic GPS or zone centroid so no stop is ever missing)
  const nodes: ResolvedRouteNode[] = useMemo(() => {
    const result: ResolvedRouteNode[] = [];
    const hasHome = isValidLatLng(homeLatitude, homeLongitude);

    if (hasHome) {
      result.push({
        id: 'home_start',
        kind: 'HOME_START',
        orderNumber: 0,
        title: 'Starting Point',
        subtitle: homeAddress || `${homeLatitude!.toFixed(4)}, ${homeLongitude!.toFixed(4)}`,
        zone: homeAddress || 'Start',
        latitude: homeLatitude!,
        longitude: homeLongitude!,
        timeWindowLabel: `Depart ${formatMinuteOfDay(plan.startMinuteOfDay)}`,
        distanceKmFromPrev: 0,
        travelMinutesFromPrev: 0,
      });
    }

    for (let i = 0; i < plan.stops.length; i++) {
      const stop = plan.stops[i];
      const clinic = clinicsByKey.get(stop.clinicKey);
      let lat = stop.latitude;
      let lng = stop.longitude;
      let gmapsUrl = clinic?.googleMapsUrl || '';

      if (!isValidLatLng(lat, lng) && clinic) {
        const eff = getEffectiveClinicCoordinates(clinic);
        lat = eff.latitude;
        lng = eff.longitude;
        if (eff.googleMapsUrl) gmapsUrl = eff.googleMapsUrl;
      }

      if (!isValidLatLng(lat, lng)) {
        const fallback = resolveZoneCentroid(
          stop.zone || clinic?.zone || '',
          `${stop.hcpTargetId}:${stop.clinicKey}`
        );
        lat = fallback.latitude;
        lng = fallback.longitude;
      }

      const singleUrl = buildGoogleMapsDirectionsUrl(
        lat,
        lng,
        gmapsUrl,
        `${stop.hcpName} ${stop.zone}`
      );

      result.push({
        id: `stop_${stop.stopOrder}_${stop.clinicKey}`,
        kind: 'STOP',
        orderNumber: stop.stopOrder,
        title: stop.hcpName,
        subtitle: `${stop.specialty || 'General'} • ${stop.clinicLabel}`,
        zone: stop.zone || clinic?.zone || '',
        latitude: lat!,
        longitude: lng!,
        timeWindowLabel: `${formatMinuteOfDay(stop.visitStartMinute)} – ${formatMinuteOfDay(stop.visitEndMinute)}`,
        distanceKmFromPrev: stop.distanceKmFromPrev,
        travelMinutesFromPrev: stop.travelMinutesFromPrev,
        executionStatus: stop.executionStatus,
        stopRef: stop,
        singleStopMapsUrl: singleUrl,
      });
    }

    if (hasHome && returnHomeRequired && plan.stops.length > 0) {
      result.push({
        id: 'home_end',
        kind: 'HOME_END',
        orderNumber: plan.stops.length + 1,
        title: 'Return to Starting Point',
        subtitle: homeAddress || `${homeLatitude!.toFixed(4)}, ${homeLongitude!.toFixed(4)}`,
        zone: homeAddress || 'Return',
        latitude: homeLatitude!,
        longitude: homeLongitude!,
        timeWindowLabel: `End ${formatMinuteOfDay(plan.endMinuteOfDay)}`,
        distanceKmFromPrev: 0,
        travelMinutesFromPrev: 0,
      });
    }

    return result;
  }, [
    plan.stops,
    plan.startMinuteOfDay,
    plan.endMinuteOfDay,
    clinicsByKey,
    homeLatitude,
    homeLongitude,
    homeAddress,
    returnHomeRequired,
  ]);

  const fullMultiStopUrl = useMemo(() => {
    const resolvedStops = nodes
      .filter((n) => n.kind === 'STOP')
      .map((n) => ({
        latitude: n.latitude,
        longitude: n.longitude,
        hcpName: n.title,
        zone: n.zone,
      }));
    return buildMultiStopGoogleMapsUrl(
      resolvedStops,
      homeLatitude,
      homeLongitude,
      returnHomeRequired
    );
  }, [nodes, homeLatitude, homeLongitude, returnHomeRequired]);

  const projection = useMemo(() => {
    if (nodes.length === 0) return null;

    const lats = nodes.map((n) => n.latitude);
    const lngs = nodes.map((n) => n.longitude);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    // Determine optimal integer zoom level (10..16) that fits all route pins inside SVG_W x SVG_H
    let autoZoom = 15;
    for (let z = 16; z >= 9; z--) {
      const xMin = lngToWorldX(minLng, z);
      const xMax = lngToWorldX(maxLng, z);
      const yMin = latToWorldY(maxLat, z);
      const yMax = latToWorldY(minLat, z);
      if (xMax - xMin <= SVG_W - PAD_X * 2 && yMax - yMin <= SVG_H - PAD_Y * 2) {
        autoZoom = z;
        break;
      }
    }

    const zoom = Math.max(9, Math.min(17, autoZoom + zoomDelta));
    const cxWorld = (lngToWorldX(minLng, zoom) + lngToWorldX(maxLng, zoom)) / 2;
    const cyWorld = (latToWorldY(maxLat, zoom) + latToWorldY(minLat, zoom)) / 2;

    const originX = cxWorld - SVG_W / 2;
    const originY = cyWorld - SVG_H / 2;

    // Project each node to exact SVG coordinates + spider-offset any overlapping pins so all numbers remain visible
    const rawPoints = nodes.map((n) => ({
      rawX: lngToWorldX(n.longitude, zoom) - originX,
      rawY: latToWorldY(n.latitude, zoom) - originY,
    }));

    const screenPoints = rawPoints.map((pt, idx) => {
      // Count earlier points within 20px of this point
      let clusterOrder = 0;
      let clusterTotal = 0;
      for (let j = 0; j < rawPoints.length; j++) {
        const dx = rawPoints[j].rawX - pt.rawX;
        const dy = rawPoints[j].rawY - pt.rawY;
        if (Math.hypot(dx, dy) < 20) {
          if (j < idx) clusterOrder++;
          clusterTotal++;
        }
      }
      if (clusterTotal <= 1) {
        return { x: pt.rawX, y: pt.rawY, rawX: pt.rawX, rawY: pt.rawY, hasOffset: false };
      }
      const angle = (clusterOrder / clusterTotal) * Math.PI * 2 - Math.PI / 2;
      const radius = 18;
      return {
        x: pt.rawX + Math.cos(angle) * radius,
        y: pt.rawY + Math.sin(angle) * radius,
        rawX: pt.rawX,
        rawY: pt.rawY,
        hasOffset: true,
      };
    });

    // Compute OpenStreetMap slippy tiles covering the viewport
    const maxTileIndex = Math.pow(2, zoom);
    const minTileX = Math.floor(originX / 256);
    const maxTileX = Math.floor((originX + SVG_W) / 256);
    const minTileY = Math.floor(originY / 256);
    const maxTileY = Math.floor((originY + SVG_H) / 256);

    const tiles: Array<{ key: string; url: string; x: number; y: number }> = [];
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        if (ty < 0 || ty >= maxTileIndex) continue;
        const wrappedTx = ((tx % maxTileIndex) + maxTileIndex) % maxTileIndex;
        tiles.push({
          key: `${zoom}_${tx}_${ty}`,
          url: `https://tile.openstreetmap.org/${zoom}/${wrappedTx}/${ty}.png`,
          x: tx * 256 - originX,
          y: ty * 256 - originY,
        });
      }
    }

    return {
      zoom,
      tiles,
      screenPoints,
    };
  }, [nodes, zoomDelta]);

  if (!projection || nodes.length === 0) {
    return null;
  }

  const activeNodeIdx =
    selectedNodeIdx !== null && selectedNodeIdx < nodes.length ? selectedNodeIdx : null;
  const activeNode = activeNodeIdx !== null ? nodes[activeNodeIdx] : null;

  const polylinePoints = projection.screenPoints
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');

  return (
    <div className="rounded-[18px] bg-[#0F172A] border border-[#334155] overflow-hidden shadow-md space-y-0">
      {/* Top Map Header Bar */}
      <div className="px-3.5 py-2.5 bg-[#1E293B] border-b border-[#334155] flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-full bg-[#2563EB]/20 text-[#60A5FA] inline-flex items-center justify-center shrink-0">
            <Navigation className="w-3.5 h-3.5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-xs font-extrabold text-white truncate">
              Full Route Map • Plan {plan.variantCode} ({plan.plannedVisitsCount} Stops •{' '}
              {plan.totalDistanceKm.toFixed(1)} km)
            </h3>
            <p className="text-[11px] text-[#94A3B8] truncate tabular-nums">
              Tap any numbered pin to inspect stop timing &amp; leg distance
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setZoomDelta((z) => Math.max(-4, z - 1))}
            className="w-7 h-7 rounded-lg bg-[#0F172A] hover:bg-[#334155] text-[#CBD5E1] inline-flex items-center justify-center border border-[#334155]"
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoomDelta(0)}
            className="h-7 px-2 rounded-lg bg-[#0F172A] hover:bg-[#334155] text-[#CBD5E1] text-[10px] font-bold inline-flex items-center gap-1 border border-[#334155]"
            title="Fit route bounds"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Fit</span>
          </button>
          <button
            type="button"
            onClick={() => setZoomDelta((z) => Math.min(3, z + 1))}
            className="w-7 h-7 rounded-lg bg-[#0F172A] hover:bg-[#334155] text-[#CBD5E1] inline-flex items-center justify-center border border-[#334155]"
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-7 h-7 rounded-lg bg-[#0F172A] hover:bg-[#334155] text-[#CBD5E1] inline-flex items-center justify-center border border-[#334155]"
            title={expanded ? 'Compact map' : 'Expand map'}
            aria-label={expanded ? 'Compact map' : 'Expand map'}
          >
            {expanded ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Interactive SVG Map Canvas with OpenStreetMap Street Tiles + Route Vectors */}
      <div className={`relative w-full ${expanded ? 'h-[380px] sm:h-[440px]' : 'h-[250px] sm:h-[290px]'} bg-[#0B1120]`}>
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          preserveAspectRatio="xMidYMid slice"
          className="w-full h-full block select-none"
          role="img"
          aria-label="Illustrated multi-stop territory route map"
        >
          <defs>
            <linearGradient id="routeLineGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#0EA5E9" />
              <stop offset="50%" stopColor="#2563EB" />
              <stop offset="100%" stopColor="#0D9488" />
            </linearGradient>
            <filter id="pinShadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="#000000" floodOpacity="0.45" />
            </filter>
          </defs>

          {/* Subtle dark fallback grid in case offline */}
          <rect x="0" y="0" width={SVG_W} height={SVG_H} fill="#0F172A" />

          {/* OpenStreetMap Slippy Street Tiles */}
          <g opacity="0.92">
            {projection.tiles.map((t) => (
              <image
                key={t.key}
                href={t.url}
                x={t.x}
                y={t.y}
                width="256"
                height="256"
                preserveAspectRatio="none"
              />
            ))}
          </g>

          {/* Slight contrast tint for crisp pin & route readability */}
          <rect x="0" y="0" width={SVG_W} height={SVG_H} fill="#0F172A" fillOpacity="0.14" />

          {/* Outer Halo + Main Route Polyline + Directional Flow Dashes */}
          {projection.screenPoints.length >= 2 && (
            <>
              <polyline
                fill="none"
                stroke="#0F172A"
                strokeOpacity="0.75"
                strokeWidth="9"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={polylinePoints}
              />
              <polyline
                fill="none"
                stroke="url(#routeLineGrad)"
                strokeWidth="5.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={polylinePoints}
              />
              <polyline
                fill="none"
                stroke="#E0F2FE"
                strokeWidth="2"
                strokeDasharray="6 8"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={polylinePoints}
              />
            </>
          )}

          {/* Leg Distance Pills & Direction Arrows along each segment */}
          {projection.screenPoints.map((pt, idx) => {
            if (idx === 0) return null;
            const prev = projection.screenPoints[idx - 1];
            const node = nodes[idx];
            const dx = pt.x - prev.x;
            const dy = pt.y - prev.y;
            const segLen = Math.hypot(dx, dy);
            if (segLen < 36) return null;

            const midX = (prev.x + pt.x) / 2;
            const midY = (prev.y + pt.y) / 2;
            const label =
              node.distanceKmFromPrev === 0
                ? '0 km'
                : `${node.distanceKmFromPrev.toFixed(1)} km`;

            return (
              <g key={`leg_${node.id}`} transform={`translate(${midX}, ${midY})`}>
                <rect
                  x="-26"
                  y="-10"
                  width="52"
                  height="20"
                  rx="10"
                  fill="#0F172A"
                  fillOpacity="0.88"
                  stroke="#38BDF8"
                  strokeWidth="1.2"
                />
                <text
                  x="0"
                  y="3.5"
                  textAnchor="middle"
                  fill="#F8FAFC"
                  fontSize="10"
                  fontWeight="700"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {label}
                </text>
              </g>
            );
          })}

          {/* Spider Leader Lines for same-building / overlapping pins */}
          {projection.screenPoints.map((pt, idx) => {
            if (!pt.hasOffset) return null;
            return (
              <g key={`leader_${nodes[idx].id}`}>
                <line
                  x1={pt.rawX}
                  y1={pt.rawY}
                  x2={pt.x}
                  y2={pt.y}
                  stroke="#0F172A"
                  strokeWidth="2"
                  strokeDasharray="2 2"
                />
                <circle cx={pt.rawX} cy={pt.rawY} r="3.5" fill="#2563EB" stroke="#FFFFFF" strokeWidth="1.2" />
              </g>
            );
          })}

          {/* Interactive Stop & Home Pins */}
          {projection.screenPoints.map((pt, idx) => {
            const node = nodes[idx];
            const isSelected = activeNodeIdx === idx;
            const isHome = node.kind === 'HOME_START' || node.kind === 'HOME_END';
            const isCompleted = node.executionStatus === 'COMPLETED';
            const pinFill = isHome
              ? '#0F766E'
              : isCompleted
                ? '#059669'
                : isSelected
                  ? '#1D4ED8'
                  : '#2563EB';
            const radius = isSelected ? 18 : isHome ? 15 : 15;

            return (
              <g
                key={node.id}
                transform={`translate(${pt.x}, ${pt.y})`}
                onClick={() => setSelectedNodeIdx(isSelected ? null : idx)}
                className="cursor-pointer"
                filter="url(#pinShadow)"
              >
                {isSelected && (
                  <circle
                    cx="0"
                    cy="0"
                    r={radius + 6}
                    fill="none"
                    stroke="#38BDF8"
                    strokeWidth="2.5"
                    strokeOpacity="0.9"
                  />
                )}
                <circle
                  cx="0"
                  cy="0"
                  r={radius}
                  fill={pinFill}
                  stroke="#FFFFFF"
                  strokeWidth="2.5"
                />
                <text
                  x="0"
                  y="4.5"
                  textAnchor="middle"
                  fill="#FFFFFF"
                  fontSize={isHome ? '11' : '12'}
                  fontWeight="800"
                  fontFamily="Inter, system-ui, sans-serif"
                >
                  {isHome ? 'H' : node.orderNumber}
                </text>

                {/* Compact Name Label above/below pin */}
                <g transform="translate(0, -24)">
                  <rect
                    x="-54"
                    y="-11"
                    width="108"
                    height="17"
                    rx="6"
                    fill="#0F172A"
                    fillOpacity="0.88"
                    stroke={isSelected ? '#38BDF8' : '#334155'}
                    strokeWidth="1"
                  />
                  <text
                    x="0"
                    y="0.5"
                    textAnchor="middle"
                    fill="#F8FAFC"
                    fontSize="9.5"
                    fontWeight="700"
                    fontFamily="Inter, system-ui, sans-serif"
                  >
                    {isHome
                      ? 'Start'
                      : `${node.orderNumber}. ${node.title.slice(0, 13)}`}
                  </text>
                </g>
              </g>
            );
          })}
        </svg>

        {/* Bottom-right OpenStreetMap attribution */}
        <span className="absolute bottom-1.5 right-2 rounded bg-[#0F172A]/80 px-1.5 py-0.5 text-[9px] text-[#94A3B8] pointer-events-none">
          © OpenStreetMap
        </span>
      </div>

      {/* Selected Stop Detail Strip (when user taps a pin or stop pill) */}
      {activeNode && (
        <div className="px-3.5 py-2.5 bg-[#1E293B] border-t border-[#334155] flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-[#2563EB] text-white text-xs font-extrabold inline-flex items-center justify-center shrink-0 tabular-nums">
                {activeNode.kind === 'STOP' ? activeNode.orderNumber : 'H'}
              </span>
              <p className="text-xs font-bold text-white truncate" dir="auto">
                {activeNode.title}
              </p>
              {activeNode.zone && (
                <span
                  className="rounded-full bg-[#0F766E]/30 text-[#2DD4BF] px-2 py-0.5 text-[10px] font-bold truncate"
                  dir="auto"
                >
                  {activeNode.zone}
                </span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-3 text-[11px] text-[#CBD5E1] tabular-nums flex-wrap">
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3 h-3 text-[#60A5FA]" />
                <span>{activeNode.timeWindowLabel}</span>
              </span>
              {activeNode.kind === 'STOP' && (
                <span className="inline-flex items-center gap-1">
                  <Car className="w-3 h-3 text-[#2DD4BF]" />
                  <span>
                    {activeNode.distanceKmFromPrev === 0
                      ? 'Same building (0 km)'
                      : `${activeNode.distanceKmFromPrev.toFixed(1)} km • ${activeNode.travelMinutesFromPrev}m from prev`}
                  </span>
                </span>
              )}
            </div>
          </div>

          {activeNode.singleStopMapsUrl && (
            <a
              href={activeNode.singleStopMapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="h-8 px-3 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-[11px] font-bold inline-flex items-center gap-1.5 shrink-0"
            >
              <Navigation className="w-3 h-3" />
              <span>Stop Pin</span>
            </a>
          )}
        </div>
      )}

      {/* Horizontal Ordered Stop Chain Pills + Open Full Multi-Stop Route in Google Maps */}
      <div className="p-3 bg-[#0F172A] border-t border-[#334155] space-y-2.5">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {nodes.map((node, idx) => {
            const isSelected = activeNodeIdx === idx;
            const isHome = node.kind !== 'STOP';
            return (
              <React.Fragment key={node.id}>
                <button
                  type="button"
                  onClick={() => setSelectedNodeIdx(isSelected ? null : idx)}
                  className={`h-7 px-2.5 rounded-full text-[11px] font-bold inline-flex items-center gap-1.5 shrink-0 border transition-colors ${
                    isSelected
                      ? 'bg-[#2563EB] text-white border-[#60A5FA]'
                      : isHome
                        ? 'bg-[#0F766E]/25 text-[#2DD4BF] border-[#0F766E]/50'
                        : 'bg-[#1E293B] text-[#E2E8F0] border-[#334155] hover:border-[#60A5FA]'
                  }`}
                >
                  {isHome ? (
                    <Home className="w-3 h-3 shrink-0" />
                  ) : (
                    <span className="w-4 h-4 rounded-full bg-[#2563EB]/30 text-[#93C5FD] text-[10px] font-extrabold inline-flex items-center justify-center tabular-nums">
                      {node.orderNumber}
                    </span>
                  )}
                  <span className="max-w-[115px] truncate" dir="auto">
                    {isHome ? 'Start' : node.title}
                  </span>
                  {node.executionStatus === 'COMPLETED' && (
                    <Check className="w-3 h-3 text-[#2DD4BF] shrink-0" />
                  )}
                </button>
                {idx < nodes.length - 1 && (
                  <span className="text-[10px] font-mono text-[#64748B] shrink-0 tabular-nums">
                    →
                  </span>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {fullMultiStopUrl && (
          <a
            href={fullMultiStopUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full h-9 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-xs font-bold inline-flex items-center justify-center gap-2 shadow-xs"
          >
            <Navigation className="w-3.5 h-3.5" />
            <span>Open Full Multi-Stop Route in Google Maps ({plan.plannedVisitsCount} Stops)</span>
            <ExternalLink className="w-3.5 h-3.5 opacity-80" />
          </a>
        )}
      </div>
    </div>
  );
};
