import { z } from 'zod';

const identifier = z.union([z.string(), z.number()]).transform(String);

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
});

export const manifestResponseSchema = z.object({
  status: z.string(),
  successResponse: z
    .array(
      z.object({
        orderNumber: z.string(),
        awbNumber: identifier,
        routeCode: z.string().nullish(),
        shippingLabel: z.string().nullish(),
        customerCode: z.string().nullish(),
      }),
    )
    .default([]),
  errorResponse: z
    .array(
      z.object({
        orderNumber: z.string().nullish(),
        customerCode: z.string().nullish(),
        message: z.string(),
      }),
    )
    .default([]),
});

export const trackingResponseSchema = z.object({
  status: z.string(),
  data: z.object({
    awbNumber: identifier,
    currentStatusCode: z.string(),
    currentStatusCodeDescription: z.string().nullish(),
    currentStatusDateTime: z.string().nullish(),
    scans: z
      .array(
        z.object({
          statusDateTime: z.string(),
          statusCode: z.string(),
          statusCodeDescription: z.string().nullish(),
          reasonCode: z.string().nullish(),
          reasonCodeDescription: z.string().nullish(),
          currentLocation: z.string().nullish(),
        }),
      )
      .default([]),
  }),
});

export const cancelResponseSchema = z.object({
  status: z.string(),
  message: z.string().nullish(),
  successResponse: z
    .array(z.object({ orderNumber: z.string().nullish(), awb: identifier, message: z.string() }))
    .default([]),
  failureResponse: z
    .array(z.object({ orderNumber: z.string().nullish(), awb: identifier, message: z.string() }))
    .default([]),
});

export const pincodeResponseSchema = z.object({
  status: z.string(),
  data: z
    .array(
      z.object({
        pincode: identifier,
        inbound: z.boolean(),
        outbound: z.boolean(),
        isActive: z.boolean(),
        serviceType: z.string().nullish(),
      }),
    )
    .default([]),
  errorPincodes: z.array(z.unknown()).default([]),
});
