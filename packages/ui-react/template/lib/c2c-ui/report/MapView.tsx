/**
 * Map report pins: stored latitude/longitude of the report's display field
 * (nested address object, `Field_latitude` store column, or top-level lat/lng).
 * There is no geocoding — a row without numbers is skipped.
 */
import type { ReportSpec } from '../types';

type Row = Record<string, unknown>;

const METERS_PER_DEG = 111320;
const MAP_PAD_DEG = 0.01;
const WIDTH = 400;
const HEIGHT = 240;

function parseCoord(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Stored latitude/longitude for a map pin. Prefers the report's display field
 * (nested address object, dotted part, or `Field_latitude` store column), then
 * top-level lat/long aliases. Same coordinate parse as the vanilla runtime.
 */
export function rowLatLng(row: Row, field: string | undefined): { lat: number; lng: number } | null {
  const pick = (names: string[]): number | null => {
    for (const name of names) {
      const n = parseCoord(row[name]);
      if (n != null) return n;
    }
    return null;
  };
  const fromObj = (obj: unknown): { lat: number; lng: number } | null => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    const lat = parseCoord(rec.latitude ?? rec.lat ?? rec.Latitude);
    const lng = parseCoord(rec.longitude ?? rec.lng ?? rec.lon ?? rec.Longitude);
    return lat != null && lng != null ? { lat, lng } : null;
  };
  if (field) {
    const nested = fromObj(row[field]);
    if (nested) return nested;
    const lat = pick([`${field}_latitude`, `${field}.latitude`, `${field}_lat`]);
    const lng = pick([`${field}_longitude`, `${field}.longitude`, `${field}_lng`, `${field}_lon`]);
    if (lat != null && lng != null) return { lat, lng };
  }
  const lat = pick(['latitude', 'Latitude', 'lat', 'Lat']);
  const lng = pick(['longitude', 'Longitude', 'lng', 'Lng', 'lon', 'Lon']);
  return lat != null && lng != null ? { lat, lng } : null;
}

function mapPadDeg(radius: number | undefined): number {
  const n = Number(radius);
  return Number.isFinite(n) && n > 0 ? n / METERS_PER_DEG : MAP_PAD_DEG;
}

function osmMarkerHref(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}

function pinTitle(row: Row, report: ReportSpec): string {
  const field = report.titleField || report.columns[0]?.field;
  if (!field) return '';
  const value = row[field];
  if (value == null || value === '') return '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.label === 'string') return obj.label;
    return Object.values(obj)
      .filter((item) => item !== '' && item != null)
      .map(String)
      .join(', ');
  }
  return String(value);
}

/** Equirectangular pin plot of the current page of rows. */
export function MapPlot({ report, rows }: { report: ReportSpec; rows: Row[] }) {
  const pins: { lat: number; lng: number; title: string; id: string }[] = [];
  for (const row of rows) {
    const pos = rowLatLng(row, report.mapField);
    if (!pos || pos.lat < -90 || pos.lat > 90 || pos.lng < -180 || pos.lng > 180) continue;
    pins.push({
      lat: pos.lat,
      lng: pos.lng,
      title: pinTitle(row, report),
      id: row.ROWID != null ? String(row.ROWID) : '',
    });
  }
  return (
    <div
      data-map=""
      {...(report.mapField ? { 'data-map-field': report.mapField } : {})}
      {...(report.mapRadius != null ? { 'data-map-radius': String(report.mapRadius) } : {})}
    >
      {pins.length === 0 ? (
        <p data-map-empty="">No mappable coordinates on this page.</p>
      ) : (
        <MapSvg report={report} pins={pins} />
      )}
    </div>
  );
}

function MapSvg({ report, pins }: { report: ReportSpec; pins: { lat: number; lng: number; title: string; id: string }[] }) {
  let minLat = pins[0]!.lat;
  let maxLat = pins[0]!.lat;
  let minLng = pins[0]!.lng;
  let maxLng = pins[0]!.lng;
  for (const pin of pins) {
    if (pin.lat < minLat) minLat = pin.lat;
    if (pin.lat > maxLat) maxLat = pin.lat;
    if (pin.lng < minLng) minLng = pin.lng;
    if (pin.lng > maxLng) maxLng = pin.lng;
  }
  const pad = mapPadDeg(report.mapRadius);
  minLat -= pad;
  maxLat += pad;
  minLng -= pad;
  maxLng += pad;
  if (minLat === maxLat) {
    minLat -= MAP_PAD_DEG;
    maxLat += MAP_PAD_DEG;
  }
  if (minLng === maxLng) {
    minLng -= MAP_PAD_DEG;
    maxLng += MAP_PAD_DEG;
  }
  const spanLat = maxLat - minLat;
  const spanLng = maxLng - minLng;
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${report.label} map`}>
      {pins.map((pin, index) => {
        const x = ((pin.lng - minLng) / spanLng) * WIDTH;
        const y = (1 - (pin.lat - minLat) / spanLat) * HEIGHT;
        return (
          <a
            key={pin.id || String(index)}
            href={osmMarkerHref(pin.lat, pin.lng)}
            data-marker=""
            data-lat={String(pin.lat)}
            data-lng={String(pin.lng)}
            {...(pin.id ? { 'data-row': pin.id } : {})}
          >
            <title>{pin.title || `${pin.lat}, ${pin.lng}`}</title>
            <circle cx={x} cy={y} r="6" />
          </a>
        );
      })}
    </svg>
  );
}
