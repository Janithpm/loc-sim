import { z } from "zod";

export const telemetryPointSchema = z
  .object({
    organizationId: z.string().uuid(),
    vehicleId: z.string().uuid().optional(),
    externalDeviceId: z.string().optional(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    recordedAt: z.string().datetime(),
    speedKph: z.number().nonnegative().optional(),
    heading: z.number().min(0).max(360).optional(),
    accuracyMeters: z.number().nonnegative().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    source: z.enum(["mock", "traccar"])
  })
  .refine((value) => Boolean(value.vehicleId || value.externalDeviceId), {
    message: "vehicleId or externalDeviceId is required",
    path: ["vehicleId"]
  });

export const telemetryPayloadSchema = z.object({
  points: z.array(telemetryPointSchema).min(1)
});

export const streamQuerySchema = z.object({
  organizationId: z.string().uuid()
});

export const scenarioSchema = z.object({
  routes: z
    .array(
      z.object({
        id: z.string().min(1),
        path: z.string().min(1)
      })
    )
    .min(1)
});

export const geoJsonRouteSchema = z.object({
  type: z.literal("Feature"),
  properties: z.object({
    id: z.string().min(1),
    name: z.string().min(1)
  }),
  geometry: z.object({
    type: z.literal("LineString"),
    coordinates: z.array(z.tuple([z.number(), z.number()])).min(2)
  })
});

export type TelemetryPoint = z.infer<typeof telemetryPointSchema>;
export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;
export type TelemetryStatus = "offline" | "moving" | "parked";

export type TelemetryEvent = {
  type: "vehicle.position.updated";
  organizationId: string;
  vehicleId: string;
  snapshot: {
    telemetryStatus: TelemetryStatus;
    isRentedNow: boolean;
    position: {
      latitude: number;
      longitude: number;
      speedKph: number | null;
      heading: number | null;
      accuracyMeters: number | null;
      recordedAt: string;
      receivedAt: string;
      source: "mock" | "traccar";
      freshnessSeconds: number;
    };
  };
  trailAppend: {
    id: string;
    latitude: number;
    longitude: number;
    speedKph: number | null;
    heading: number | null;
    recordedAt: string;
    source: "mock" | "traccar";
  };
};

export type Scenario = z.infer<typeof scenarioSchema>;
export type GeoJsonRoute = z.infer<typeof geoJsonRouteSchema>;
