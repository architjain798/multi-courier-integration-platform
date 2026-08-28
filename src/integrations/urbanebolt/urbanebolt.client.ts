import { CourierOperation, type CourierAudit } from '../../components/couriers/index.js';
import { ErrorCode } from '../../libraries/errors/index.js';
import type { UrbaneBoltConfig } from './urbanebolt.config.js';
import {
  authError,
  envelopeMessage,
  isAuthFailureResponse,
  isFailedEnvelope,
  transportError,
} from './urbanebolt.errors.js';
import { tokenResponseSchema } from './urbanebolt.schemas.js';

const TOKEN_SAFETY_MARGIN_SECONDS = 60;

export type RawCall = {
  status: number;
  body: unknown;
};

type SendOptions = {
  body?: unknown;
  auditBody?: unknown;
  token?: string;
  audit: CourierAudit[];
};

export class UrbaneBoltClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: UrbaneBoltConfig) {}

  invalidateToken(): void {
    this.token = null;
  }

  async authenticate(audit: CourierAudit[]): Promise<string> {
    const cached = this.token;
    if (cached !== null && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const call = await this.send(CourierOperation.AUTHENTICATE, 'POST', '/api/v1/auth/getToken/', {
      body: { username: this.config.username, password: this.config.password },
      auditBody: { username: this.config.username, password: '[redacted]' },
      audit,
    });

    if (isAuthFailureResponse(call.status, call.body) || isFailedEnvelope(call.body)) {
      throw authError(envelopeMessage(call.body), audit);
    }

    const parsed = tokenResponseSchema.safeParse(call.body);
    if (!parsed.success) {
      throw authError('UrbaneBolt returned an unrecognised token response', audit);
    }

    this.token = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + (parsed.data.expires_in - TOKEN_SAFETY_MARGIN_SECONDS) * 1000,
    };
    return this.token.value;
  }

  async call(
    operation: CourierOperation,
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; audit: CourierAudit[] },
  ): Promise<RawCall> {
    const token = await this.authenticate(options.audit);
    const call = await this.send(operation, method, path, {
      ...(options.body === undefined ? {} : { body: options.body }),
      token,
      audit: options.audit,
    });

    if (isAuthFailureResponse(call.status, call.body)) {
      throw authError(envelopeMessage(call.body), options.audit);
    }
    return call;
  }

  private async send(
    operation: CourierOperation,
    method: 'GET' | 'POST',
    path: string,
    options: SendOptions,
  ): Promise<RawCall> {
    const url = `${this.config.baseUrl}${path}`;
    const startedAt = Date.now();
    const auditBody = options.auditBody ?? options.body ?? null;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      options.audit.push({
        operation,
        url,
        requestBody: auditBody,
        responseStatus: 0,
        responseBody: { error: error instanceof Error ? error.message : String(error) },
        durationMs: Date.now() - startedAt,
      });
      throw transportError(
        timedOut ? ErrorCode.COURIER_TIMEOUT : ErrorCode.COURIER_UNAVAILABLE,
        timedOut
          ? `UrbaneBolt did not respond within ${this.config.timeoutMs}ms`
          : 'UrbaneBolt is unreachable',
        options.audit,
      );
    }

    const text = await response.text();
    const body = parseJson(text);
    options.audit.push({
      operation,
      url,
      requestBody: auditBody,
      responseStatus: response.status,
      responseBody: body,
      durationMs: Date.now() - startedAt,
    });

    if (response.status === 429) {
      throw transportError(
        ErrorCode.COURIER_RATE_LIMITED,
        'UrbaneBolt rate limit exceeded',
        options.audit,
      );
    }
    if (response.status >= 500) {
      throw transportError(
        ErrorCode.COURIER_UNAVAILABLE,
        `UrbaneBolt returned ${response.status}`,
        options.audit,
      );
    }

    return { status: response.status, body };
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
