import type { LonLat, ParsedShareUrl, RouteType } from './types';

const VALID_ROUTE_TYPES = new Set<RouteType>([
  'car_fast',
  'car_fast_traffic',
  'car_short',
  'foot_fast',
  'foot_hiking',
  'bike_road',
  'bike_mountain'
]);

function parseLonLat(s: string): LonLat | null {
  const [lonStr, latStr] = s.split(',');
  const lon = Number(lonStr);
  const lat = Number(latStr);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon, lat };
}

export function parseShareUrl(input: string): ParsedShareUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('mapy.com') && !host.endsWith('mapy.cz')) return null;
  if (!url.pathname.includes('/route')) return null;

  const startStr = url.searchParams.get('start');
  const endStr = url.searchParams.get('end');
  const routeTypeRaw = url.searchParams.get('routeType');
  if (!startStr || !endStr || !routeTypeRaw) return null;
  if (!VALID_ROUTE_TYPES.has(routeTypeRaw as RouteType)) return null;

  const start = parseLonLat(startStr);
  const end = parseLonLat(endStr);
  if (!start || !end) return null;

  const wpStr = url.searchParams.get('waypoints');
  const waypoints: LonLat[] = [];
  if (wpStr) {
    for (const part of wpStr.split(';')) {
      const wp = parseLonLat(part);
      if (wp) waypoints.push(wp);
    }
  }

  return {
    start,
    end,
    waypoints,
    routeType: routeTypeRaw as RouteType,
    raw: input.trim()
  };
}
