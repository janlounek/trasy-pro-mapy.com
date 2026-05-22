import type { LonLat, SavedRoute } from './types';

interface GeoJSONGeometry {
  type?: string;
  coordinates?: unknown;
  geometry?: GeoJSONGeometry;
  features?: GeoJSONGeometry[];
}

function isCoordPair(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number'
  );
}

function extractCoords(g: GeoJSONGeometry | null): LonLat[] {
  if (!g || typeof g !== 'object') return [];
  switch (g.type) {
    case 'LineString':
      if (Array.isArray(g.coordinates)) {
        const out: LonLat[] = [];
        for (const c of g.coordinates) {
          if (isCoordPair(c)) out.push({ lon: c[0], lat: c[1] });
        }
        return out;
      }
      return [];
    case 'MultiLineString':
      if (Array.isArray(g.coordinates)) {
        const out: LonLat[] = [];
        for (const seg of g.coordinates) {
          if (Array.isArray(seg)) {
            for (const c of seg) {
              if (isCoordPair(c)) out.push({ lon: c[0], lat: c[1] });
            }
          }
        }
        return out;
      }
      return [];
    case 'Feature':
      return extractCoords(g.geometry ?? null);
    case 'FeatureCollection':
      if (Array.isArray(g.features)) {
        const out: LonLat[] = [];
        for (const f of g.features) out.push(...extractCoords(f));
        return out;
      }
      return [];
    default:
      // Some routing APIs return the geometry directly without a "type" wrapper.
      if (Array.isArray(g.coordinates)) {
        const flat = (g.coordinates as unknown[]).flat();
        const out: LonLat[] = [];
        for (const c of flat) {
          if (isCoordPair(c)) out.push({ lon: c[0], lat: c[1] });
        }
        return out;
      }
      return [];
  }
}

export function getRouteCoordinates(route: SavedRoute): LonLat[] {
  if (route.geometry) {
    try {
      const parsed = JSON.parse(route.geometry) as GeoJSONGeometry;
      const coords = extractCoords(parsed);
      if (coords.length >= 2) return coords;
    } catch {
      // fall through
    }
  }
  return [route.start, ...route.waypoints, route.end];
}
