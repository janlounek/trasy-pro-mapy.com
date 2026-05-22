import type { LonLat, ParsedShareUrl } from './types';

const BASE = 'https://api.mapy.com';

function getKey(): string {
  const k = import.meta.env.VITE_MAPY_API_KEY;
  if (!k) {
    throw new Error('VITE_MAPY_API_KEY is not set. Add it to .env.local and rebuild.');
  }
  return k;
}

export interface RouteResponse {
  distanceM: number;
  durationS: number;
  geometry?: string;
}

export async function fetchRoute(p: ParsedShareUrl): Promise<RouteResponse> {
  const key = getKey();
  const u = new URL(`${BASE}/v1/routing/route`);
  u.searchParams.set('start', `${p.start.lon},${p.start.lat}`);
  u.searchParams.set('end', `${p.end.lon},${p.end.lat}`);
  u.searchParams.set('routeType', p.routeType);
  u.searchParams.set('format', 'geojson');
  u.searchParams.set('lang', 'cs');
  if (p.waypoints.length) {
    u.searchParams.set(
      'waypoints',
      p.waypoints.map((w) => `${w.lon},${w.lat}`).join(';')
    );
  }
  u.searchParams.set('apikey', key);

  const res = await fetch(u.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Routing failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as {
    length?: number;
    duration?: number;
    geometry?: unknown;
  };
  return {
    distanceM: typeof json.length === 'number' ? json.length : 0,
    durationS: typeof json.duration === 'number' ? json.duration : 0,
    geometry: json.geometry ? JSON.stringify(json.geometry) : undefined
  };
}

export interface ElevationSample {
  lon: number;
  lat: number;
  elevation: number;
}

/**
 * Look up elevation for up to 256 points. Returns parallel array with samples
 * (filters out obvious sentinel values like the API's -100000 polar marker).
 */
export async function fetchElevation(coords: LonLat[]): Promise<ElevationSample[]> {
  const key = getKey();
  const points = coords.slice(0, 256);
  if (points.length === 0) return [];
  const positions = points.map((c) => `${c.lon},${c.lat}`).join(';');
  const u = new URL(`${BASE}/v1/elevation`);
  u.searchParams.set('positions', positions);
  u.searchParams.set('apikey', key);
  const res = await fetch(u.toString());
  if (!res.ok) {
    throw new Error(`Elevation failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      elevation?: number;
      position?: { lon?: number; lat?: number };
    }>;
  };
  const out: ElevationSample[] = [];
  for (const it of json.items ?? []) {
    if (typeof it.elevation !== 'number') continue;
    if (it.elevation < -9000) continue; // sentinel value near poles
    out.push({
      lon: it.position?.lon ?? 0,
      lat: it.position?.lat ?? 0,
      elevation: it.elevation
    });
  }
  return out;
}

/** Sum positive and negative elevation deltas along an ordered elevation series. */
export function elevationGainLoss(
  elevations: number[]
): { gainM: number; lossM: number } {
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < elevations.length; i++) {
    const diff = elevations[i] - elevations[i - 1];
    if (diff > 0) gain += diff;
    else loss -= diff;
  }
  return { gainM: Math.round(gain), lossM: Math.round(loss) };
}

interface RgeoItem {
  /** Primary identifier — the actual place name (e.g. "Sněžka", "Krásnohorská 12"). */
  name?: string;
  /** A descriptive category like "Adresa" or "POI" — NOT the place name. */
  label?: string;
  /** Short label for the locality of the resolved entity (e.g. "Pec pod Sněžkou"). */
  location?: string;
  type?: string;
}

export async function reverseGeocode(p: LonLat): Promise<string | undefined> {
  const key = getKey();
  const u = new URL(`${BASE}/v1/rgeocode`);
  u.searchParams.set('lon', String(p.lon));
  u.searchParams.set('lat', String(p.lat));
  u.searchParams.set('lang', 'cs');
  u.searchParams.set('apikey', key);

  try {
    const res = await fetch(u.toString());
    if (!res.ok) return undefined;
    const json = (await res.json()) as { items?: RgeoItem[] };
    const first = json.items?.[0];
    if (!first) return undefined;
    // `label` is the entity type (e.g. "Adresa") — useless for display. Prefer
    // `name`, optionally followed by `location` (the locality) for context.
    const name = first.name?.trim();
    const loc = first.location?.trim();
    if (name && loc && loc !== name) return `${name}, ${loc}`;
    if (name) return name;
    if (loc) return loc;
    return undefined;
  } catch {
    return undefined;
  }
}
