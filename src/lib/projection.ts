import type { LonLat } from './types';

const TILE_SIZE = 256;

export interface Viewport {
  lon: number;
  lat: number;
  zoom: number;
  width: number;
  height: number;
}

function scaleAt(zoom: number): number {
  return Math.pow(2, zoom) * TILE_SIZE;
}

function lonToWorldX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * scaleAt(zoom);
}

function latToWorldY(lat: number, zoom: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scaleAt(zoom);
}

export function lonLatToScreen(
  lon: number,
  lat: number,
  vp: Viewport
): { x: number; y: number } {
  const wx = lonToWorldX(lon, vp.zoom);
  const wy = latToWorldY(lat, vp.zoom);
  const cx = lonToWorldX(vp.lon, vp.zoom);
  const cy = latToWorldY(vp.lat, vp.zoom);
  return {
    x: vp.width / 2 + (wx - cx),
    y: vp.height / 2 + (wy - cy)
  };
}

export function screenToLonLat(x: number, y: number, vp: Viewport): LonLat {
  const cx = lonToWorldX(vp.lon, vp.zoom);
  const cy = latToWorldY(vp.lat, vp.zoom);
  const wx = x - vp.width / 2 + cx;
  const wy = y - vp.height / 2 + cy;
  const scale = scaleAt(vp.zoom);
  const lon = (wx / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * wy) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lon, lat };
}
