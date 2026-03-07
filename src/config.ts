import "dotenv/config";

import { z } from "zod";

const uuidOrEmptySchema = z.union([z.string().uuid(), z.literal("")]);

const serverEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4100),
  DATABASE_URL: z.string().min(1),
  TELEMETRY_GATEWAY_TOKEN: z.string().min(1)
});

const simulatorEnvSchema = z.object({
  SIM_GATEWAY_URL: z.string().url().default("http://localhost:4100"),
  TELEMETRY_GATEWAY_TOKEN: z.string().min(1).default("shared-secret"),
  SIM_ORGANIZATION_ID: uuidOrEmptySchema.default(""),
  SIM_VEHICLE_ID_1: uuidOrEmptySchema.default(""),
  SIM_VEHICLE_ID_2: uuidOrEmptySchema.default(""),
  SIM_VEHICLE_ID_3: uuidOrEmptySchema.default(""),
  SIM_VEHICLE_ID_4: uuidOrEmptySchema.default("")
});

export function loadServerConfig() {
  const env = serverEnvSchema.parse(process.env);

  return {
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    gatewayToken: env.TELEMETRY_GATEWAY_TOKEN
  };
}

export function loadSimulatorConfig() {
  const env = simulatorEnvSchema.parse(process.env);

  return {
    gatewayUrl: env.SIM_GATEWAY_URL,
    gatewayToken: env.TELEMETRY_GATEWAY_TOKEN,
    organizationId: env.SIM_ORGANIZATION_ID,
    vehicleIds: [
      env.SIM_VEHICLE_ID_1,
      env.SIM_VEHICLE_ID_2,
      env.SIM_VEHICLE_ID_3,
      env.SIM_VEHICLE_ID_4
    ]
  };
}
