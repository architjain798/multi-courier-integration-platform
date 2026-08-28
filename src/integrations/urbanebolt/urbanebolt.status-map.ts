import { ShipmentStatus } from '../../components/couriers/index.js';

// Only MAN and CAN are confirmed against the live UAT API. UrbaneBolt does not publish its full
// scan-code list, so the rest are best-effort and anything unrecognised falls through to UNKNOWN
// rather than being forced into a wrong bucket.
const STATUS_BY_CODE: Readonly<Record<string, ShipmentStatus>> = {
  MAN: ShipmentStatus.CREATED,
  CAN: ShipmentStatus.CANCELLED,
  PKD: ShipmentStatus.PICKED_UP,
  PUP: ShipmentStatus.PICKED_UP,
  INT: ShipmentStatus.IN_TRANSIT,
  RCV: ShipmentStatus.IN_TRANSIT,
  BAG: ShipmentStatus.IN_TRANSIT,
  OFD: ShipmentStatus.OUT_FOR_DELIVERY,
  DEL: ShipmentStatus.DELIVERED,
  UND: ShipmentStatus.UNDELIVERED,
  NDR: ShipmentStatus.UNDELIVERED,
  RTO: ShipmentStatus.RTO,
  RTD: ShipmentStatus.RTO,
};

export function toShipmentStatus(courierStatusCode: string): ShipmentStatus {
  return STATUS_BY_CODE[courierStatusCode.trim().toUpperCase()] ?? ShipmentStatus.UNKNOWN;
}

export function isMappedStatus(courierStatusCode: string): boolean {
  return courierStatusCode.trim().toUpperCase() in STATUS_BY_CODE;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const IST_OFFSET_MINUTES = 330;
const TIMESTAMP = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?$/;

// UrbaneBolt returns "27 Aug 2026, 17:34" with no timezone. Date.parse would read it in the
// server's local zone, which silently shifts every tracking event once deployed outside IST.
export function parseUrbaneBoltTimestamp(value: string): Date | null {
  const match = TIMESTAMP.exec(value.trim());
  if (match === null) {
    return null;
  }

  const [, day, monthName, year, hour, minute] = match;
  const month = MONTHS[(monthName ?? '').toLowerCase()];
  if (month === undefined || day === undefined || year === undefined) {
    return null;
  }

  const utcMillis = Date.UTC(
    Number(year),
    month,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
  );
  return new Date(utcMillis - IST_OFFSET_MINUTES * 60_000);
}
