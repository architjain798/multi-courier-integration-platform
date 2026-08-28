import {
  CourierOperation,
  ServiceLevel,
  ShipmentStatus,
  type BatchCreateOutcome,
  type CancellationOutcome,
  type CourierAdapter,
  type CourierAudit,
  type CourierCapabilities,
  type CourierResult,
  type NormalizedOrder,
  type ServiceabilityInfo,
  type ShipmentCreated,
  type TrackingScan,
  type TrackingSnapshot,
} from '../../components/couriers/index.js';
import { ErrorCode, isAppError } from '../../libraries/errors/index.js';
import type { Logger } from '../../libraries/logger/index.js';
import { type UrbaneBoltClient } from './urbanebolt.client.js';
import type { UrbaneBoltConfig } from './urbanebolt.config.js';
import {
  businessError,
  COURIER_ID,
  envelopeMessage,
  isFailedEnvelope,
} from './urbanebolt.errors.js';
import { toManifestItem } from './urbanebolt.mapper.js';
import {
  cancelResponseSchema,
  manifestResponseSchema,
  pincodeResponseSchema,
  trackingResponseSchema,
} from './urbanebolt.schemas.js';
import {
  isMappedStatus,
  parseUrbaneBoltTimestamp,
  toShipmentStatus,
} from './urbanebolt.status-map.js';

const SERVICE_LEVEL_BY_CODE: Readonly<Record<string, ServiceLevel>> = {
  SDD: ServiceLevel.SAME_DAY,
  NDD: ServiceLevel.NEXT_DAY,
};

export class UrbaneBoltAdapter implements CourierAdapter {
  readonly id = COURIER_ID;
  readonly capabilities: CourierCapabilities;

  constructor(
    private readonly config: UrbaneBoltConfig,
    private readonly client: UrbaneBoltClient,
    private readonly logger: Logger,
  ) {
    this.capabilities = {
      supportsBatchCreate: true,
      maxBatchSize: config.maxBatchSize,
      supportsCancel: true,
      supportsServiceability: true,
    };
  }

  // UrbaneBolt has no single-shipment endpoint. A one-order manifest is the single-order path.
  async createShipment(order: NormalizedOrder): Promise<CourierResult<ShipmentCreated>> {
    const result = await this.createShipments([order]);
    const outcome = result.value[0];

    if (outcome === undefined) {
      throw businessError('UrbaneBolt returned no outcome for the order', result.audit);
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return { value: outcome.shipment, audit: result.audit };
  }

  async createShipments(orders: NormalizedOrder[]): Promise<CourierResult<BatchCreateOutcome[]>> {
    const audit: CourierAudit[] = [];
    const payload = orders.map((order) => toManifestItem(order, this.config));

    const call = await this.client.call(
      CourierOperation.CREATE_SHIPMENT,
      'POST',
      '/api/v1/services/manifest/',
      { body: payload, audit },
    );

    if (isFailedEnvelope(call.body)) {
      throw businessError(envelopeMessage(call.body), audit);
    }

    const parsed = manifestResponseSchema.safeParse(call.body);
    if (!parsed.success) {
      throw businessError('UrbaneBolt returned an unrecognised manifest response', audit);
    }

    const outcomes: BatchCreateOutcome[] = parsed.data.successResponse.map((entry) => ({
      orderId: entry.orderNumber,
      ok: true as const,
      shipment: {
        orderId: entry.orderNumber,
        awb: entry.awbNumber,
        status: ShipmentStatus.CREATED,
        ...(entry.customerCode == null ? {} : { courierOrderId: entry.customerCode }),
        ...(entry.shippingLabel == null ? {} : { labelUrl: entry.shippingLabel }),
      },
    }));

    for (const entry of parsed.data.errorResponse) {
      outcomes.push({
        orderId: entry.orderNumber ?? '',
        ok: false,
        error: businessError(entry.message, audit),
      });
    }

    return { value: outcomes, audit };
  }

  async trackShipment(awb: string): Promise<CourierResult<TrackingSnapshot>> {
    const audit: CourierAudit[] = [];
    const call = await this.client.call(
      CourierOperation.TRACK_SHIPMENT,
      'GET',
      `/api/v1/services/tracking-pub/?awb=${encodeURIComponent(awb)}`,
      { audit },
    );

    if (isFailedEnvelope(call.body)) {
      throw businessError(envelopeMessage(call.body), audit);
    }

    const parsed = trackingResponseSchema.safeParse(call.body);
    if (!parsed.success) {
      throw businessError('UrbaneBolt returned an unrecognised tracking response', audit);
    }

    const scans: TrackingScan[] = [];
    for (const scan of parsed.data.data.scans) {
      const eventTime = parseUrbaneBoltTimestamp(scan.statusDateTime);
      if (eventTime === null) {
        // Storing an unparseable timestamp would break the dedup key that makes tracking history
        // append-only, so the scan is dropped here and stays recoverable from courier_api_logs.
        this.logger.warn(
          { courier: this.id, awb, statusDateTime: scan.statusDateTime },
          'Dropping tracking scan with an unparseable timestamp',
        );
        continue;
      }
      this.warnIfUnmapped(scan.statusCode, awb);

      scans.push({
        status: toShipmentStatus(scan.statusCode),
        courierStatusCode: scan.statusCode,
        eventTime,
        raw: { ...scan },
        ...(scan.statusCodeDescription == null
          ? {}
          : { courierStatusDescription: scan.statusCodeDescription }),
        ...(scan.reasonCode == null ? {} : { reasonCode: scan.reasonCode }),
        ...(scan.reasonCodeDescription == null
          ? {}
          : { reasonDescription: scan.reasonCodeDescription }),
        ...(scan.currentLocation == null || scan.currentLocation.length === 0
          ? {}
          : { location: scan.currentLocation }),
      });
    }

    this.warnIfUnmapped(parsed.data.data.currentStatusCode, awb);

    return {
      value: {
        awb: parsed.data.data.awbNumber,
        status: toShipmentStatus(parsed.data.data.currentStatusCode),
        scans,
      },
      audit,
    };
  }

  async cancelShipment(awb: string): Promise<CourierResult<CancellationOutcome>> {
    const audit: CourierAudit[] = [];
    const call = await this.client.call(
      CourierOperation.CANCEL_SHIPMENT,
      'POST',
      '/api/v1/services/cancel/',
      { body: { awbs: awb }, audit },
    );

    if (isFailedEnvelope(call.body)) {
      throw businessError(envelopeMessage(call.body), audit);
    }

    const parsed = cancelResponseSchema.safeParse(call.body);
    if (!parsed.success) {
      throw businessError('UrbaneBolt returned an unrecognised cancellation response', audit);
    }

    const failure = parsed.data.failureResponse[0];
    if (failure !== undefined) {
      throw businessError(failure.message, audit);
    }

    const success = parsed.data.successResponse[0];
    if (success === undefined) {
      throw businessError('UrbaneBolt reported neither success nor failure', audit);
    }

    return { value: { awb, message: success.message }, audit };
  }

  async checkServiceability(pincodes: string[]): Promise<CourierResult<ServiceabilityInfo[]>> {
    const audit: CourierAudit[] = [];
    const call = await this.client.call(
      CourierOperation.CHECK_SERVICEABILITY,
      'GET',
      `/api/v1/location/pincodes/?pincodes=${encodeURIComponent(pincodes.join(','))}`,
      { audit },
    );

    if (isFailedEnvelope(call.body)) {
      throw businessError(envelopeMessage(call.body), audit);
    }

    const parsed = pincodeResponseSchema.safeParse(call.body);
    if (!parsed.success) {
      throw businessError('UrbaneBolt returned an unrecognised pincode response', audit);
    }

    const value = parsed.data.data.map((entry) => ({
      pincode: entry.pincode,
      serviceable: entry.isActive && entry.inbound,
      inbound: entry.inbound,
      outbound: entry.outbound,
      serviceLevels: toServiceLevels(entry.serviceType),
    }));

    return { value, audit };
  }

  isAuthFailure(error: unknown): boolean {
    return isAppError(error) && error.code === ErrorCode.COURIER_AUTH_ERROR;
  }

  invalidateAuth(): Promise<void> {
    this.client.invalidateToken();
    return Promise.resolve();
  }

  private warnIfUnmapped(courierStatusCode: string, awb: string): void {
    if (!isMappedStatus(courierStatusCode)) {
      this.logger.warn(
        { courier: this.id, awb, courierStatusCode },
        'Unmapped UrbaneBolt status code, recorded as UNKNOWN',
      );
    }
  }
}

function toServiceLevels(serviceType: string | null | undefined): ServiceLevel[] {
  if (serviceType == null) {
    return [];
  }

  const levels = new Set<ServiceLevel>();
  for (const code of serviceType.split(',')) {
    const level = SERVICE_LEVEL_BY_CODE[code.trim().toUpperCase()];
    if (level !== undefined) {
      levels.add(level);
    }
  }
  if (levels.has(ServiceLevel.NEXT_DAY)) {
    levels.add(ServiceLevel.STANDARD);
  }
  return [...levels];
}
