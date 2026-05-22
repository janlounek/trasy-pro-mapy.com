import type { LonLat, RouteShape, RouteType } from './types';

const EARTH_R_M = 6371000;

export function haversine(a: LonLat, b: LonLat): number {
  const phi1 = (a.lat * Math.PI) / 180;
  const phi2 = (b.lat * Math.PI) / 180;
  const dPhi = ((b.lat - a.lat) * Math.PI) / 180;
  const dLam = ((b.lon - a.lon) * Math.PI) / 180;
  const sinDPhi = Math.sin(dPhi / 2);
  const sinDLam = Math.sin(dLam / 2);
  const x =
    sinDPhi * sinDPhi + Math.cos(phi1) * Math.cos(phi2) * sinDLam * sinDLam;
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return EARTH_R_M * c;
}

export function polylineDistance(points: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i - 1], points[i]);
  }
  return Math.round(total);
}

/** Cumulative distance along the polyline (length === points.length). */
export function cumulativeDistances(points: LonLat[]): number[] {
  const out = new Array<number>(points.length);
  if (points.length === 0) return out;
  out[0] = 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i - 1], points[i]);
    out[i] = total;
  }
  return out;
}

/**
 * Pick at most `maxCount` evenly-spaced intermediate points from a long polyline
 * so we can reconstruct a usable mapy.com share-URL (which caps at 15 waypoints).
 */
export function pickIntermediates(points: LonLat[], maxCount = 15): LonLat[] {
  if (points.length <= 2) return [];
  const middle = points.slice(1, -1);
  if (middle.length <= maxCount) return middle;
  const step = middle.length / (maxCount + 1);
  const out: LonLat[] = [];
  for (let i = 1; i <= maxCount; i++) {
    out.push(middle[Math.floor(step * i)]);
  }
  return out;
}

/** Evenly sample a polyline down to `maxN` points (keeps first + last). */
export function sampleEvenly<T>(items: T[], maxN: number): T[] {
  if (items.length <= maxN) return items.slice();
  if (maxN <= 1) return [items[0]];
  const step = (items.length - 1) / (maxN - 1);
  const out: T[] = [];
  for (let i = 0; i < maxN; i++) {
    out.push(items[Math.round(step * i)]);
  }
  return out;
}

/** Rough speed (km/h) used to estimate duration when the routing API can't. */
const ROUTE_TYPE_SPEEDS_KMH: Record<RouteType, number> = {
  foot_hiking: 4,
  foot_fast: 6,
  bike_road: 18,
  bike_mountain: 12,
  car_fast: 60,
  car_fast_traffic: 50,
  car_short: 50
};

/**
 * Naismith-style hiking parameters. For each foot route type, time =
 * distance / flatKmh + ascent / ascentMperH + descent / descentMperH (hours).
 * Cycling and driving don't get an elevation correction here.
 *
 * Numbers chosen to roughly match mapy.com's hiking estimates: an 8 km route
 * with 1800 m of ascent/descent works out to ~8 hours.
 */
const NAISMITH_PARAMS: Partial<
  Record<RouteType, { flatKmh: number; ascentMperH: number; descentMperH: number }>
> = {
  foot_hiking: { flatKmh: 4, ascentMperH: 400, descentMperH: 800 },
  foot_fast: { flatKmh: 6, ascentMperH: 600, descentMperH: 1000 }
};

/**
 * Estimate route duration in seconds. When the route type is on foot AND
 * elevation gain/loss is known, applies Naismith's rule. Otherwise falls back
 * to a simple distance/speed estimate.
 */
/**
 * Classify a polyline as a unique loop, an out-and-back, or a one-way path.
 *
 * Logic:
 *  1. If start and end are NOT near each other → one-way (A to B, different
 *     places).
 *  2. If they ARE close (closed route), test whether the first half retraces
 *     in the second half:
 *      - retrace detected → out-and-back (same way up and back)
 *      - no retrace → loop (a true unique circuit)
 *
 * Ordering matters: checking retrace BEFORE returning 'loop' is what
 * distinguishes a real circle from a there-and-back hike that happens to
 * end where it started.
 */
export function classifyRouteShape(coords: LonLat[]): RouteShape {
  if (coords.length < 4) return 'one-way';
  const total = polylineDistance(coords);
  const start = coords[0];
  const end = coords[coords.length - 1];
  const startEndDist = haversine(start, end);

  // Closed route = start ≈ end and the path is non-trivial in length.
  const loopThreshold = Math.min(200, Math.max(50, total * 0.05));
  const isClosed = startEndDist < loopThreshold && total > 500;
  if (!isClosed) return 'one-way';

  // It's a closed route — does the second half retrace the first half?
  const halfIdx = Math.floor(coords.length / 2);
  if (halfIdx < 2) return 'loop';
  const firstHalf = coords.slice(0, halfIdx);
  const secondHalf = coords.slice(halfIdx);
  const sampleCount = Math.min(10, firstHalf.length);

  let totalMinDist = 0;
  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.floor((i / Math.max(1, sampleCount - 1)) * (firstHalf.length - 1));
    const sample = firstHalf[idx];
    let minDist = Infinity;
    for (const p of secondHalf) {
      const d = haversine(sample, p);
      if (d < minDist) minDist = d;
    }
    totalMinDist += minDist;
  }
  const avgMinDist = totalMinDist / sampleCount;

  // 50 m tolerance — typical GPS noise + trail width.
  if (avgMinDist < 50) return 'out-and-back';
  return 'loop';
}

export function estimateDurationSec(
  distanceM: number,
  routeType: RouteType,
  elevGainM = 0,
  elevLossM = 0
): number {
  const naismith = NAISMITH_PARAMS[routeType];
  if (naismith) {
    const hours =
      distanceM / 1000 / naismith.flatKmh +
      Math.max(0, elevGainM) / naismith.ascentMperH +
      Math.max(0, elevLossM) / naismith.descentMperH;
    return Math.round(hours * 3600);
  }
  const kmh = ROUTE_TYPE_SPEEDS_KMH[routeType] ?? 5;
  const mps = (kmh * 1000) / 3600;
  return Math.round(distanceM / mps);
}
