import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type { TelemetryEvent, TelemetryPoint, TelemetryStatus } from "./types.js";

const ACTIVE_RENTAL_STATUSES = ["scheduled", "active"];

type ResolvedVehicle = {
  vehicleId: string;
  deviceId: string | null;
};

function computeTelemetryStatus(
  recordedAt: Date,
  receivedAt: Date,
  speedKph?: number
): TelemetryStatus {
  const ageMs = receivedAt.getTime() - recordedAt.getTime();

  if (ageMs > 30 * 60 * 1000) {
    return "offline";
  }

  if (ageMs <= 2 * 60 * 1000 && (speedKph ?? 0) >= 8) {
    return "moving";
  }

  return "parked";
}

export class TelemetryStore {
  private readonly pool: Pool;
  private rentalTableName: "public.rental" | "public.rentals" | null | undefined;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString
    });
  }

  async ingestPoints(points: TelemetryPoint[]) {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const events: TelemetryEvent[] = [];

      for (const point of points) {
        const receivedAt = new Date();
        const event = await this.persistPoint(client, point, receivedAt);
        events.push(event);
      }

      await client.query("COMMIT");
      return events;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  private async persistPoint(
    client: PoolClient,
    point: TelemetryPoint,
    receivedAt: Date
  ) {
    const resolvedVehicle = await this.resolveVehicle(client, point);
    const historyId = randomUUID();
    const recordedAt = new Date(point.recordedAt);
    const attributesJson = point.attributes ? JSON.stringify(point.attributes) : null;

    await client.query(
      `
        INSERT INTO vehicle_position_history (
          id,
          organization_id,
          vehicle_id,
          device_id,
          latitude,
          longitude,
          speed_kph,
          heading,
          accuracy_meters,
          recorded_at,
          received_at,
          source,
          attributes_json
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13::jsonb
        )
      `,
      [
        historyId,
        point.organizationId,
        resolvedVehicle.vehicleId,
        resolvedVehicle.deviceId,
        point.latitude,
        point.longitude,
        point.speedKph ?? null,
        point.heading ?? null,
        point.accuracyMeters ?? null,
        recordedAt,
        receivedAt,
        point.source,
        attributesJson
      ]
    );

    await client.query(
      `
        INSERT INTO vehicle_live_position (
          organization_id,
          vehicle_id,
          device_id,
          latitude,
          longitude,
          speed_kph,
          heading,
          accuracy_meters,
          recorded_at,
          received_at,
          source,
          attributes_json
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12::jsonb
        )
        ON CONFLICT (organization_id, vehicle_id)
        DO UPDATE SET
          device_id = EXCLUDED.device_id,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          speed_kph = EXCLUDED.speed_kph,
          heading = EXCLUDED.heading,
          accuracy_meters = EXCLUDED.accuracy_meters,
          recorded_at = EXCLUDED.recorded_at,
          received_at = EXCLUDED.received_at,
          source = EXCLUDED.source,
          attributes_json = EXCLUDED.attributes_json
      `,
      [
        point.organizationId,
        resolvedVehicle.vehicleId,
        resolvedVehicle.deviceId,
        point.latitude,
        point.longitude,
        point.speedKph ?? null,
        point.heading ?? null,
        point.accuracyMeters ?? null,
        recordedAt,
        receivedAt,
        point.source,
        attributesJson
      ]
    );

    const isRentedNow = await this.lookupRentalState(client, resolvedVehicle.vehicleId);
    const freshnessSeconds = Math.max(
      0,
      Math.floor((receivedAt.getTime() - recordedAt.getTime()) / 1000)
    );

    return {
      type: "vehicle.position.updated" as const,
      organizationId: point.organizationId,
      vehicleId: resolvedVehicle.vehicleId,
      snapshot: {
        telemetryStatus: computeTelemetryStatus(recordedAt, receivedAt, point.speedKph),
        isRentedNow,
        position: {
          latitude: point.latitude,
          longitude: point.longitude,
          speedKph: point.speedKph ?? null,
          heading: point.heading ?? null,
          accuracyMeters: point.accuracyMeters ?? null,
          recordedAt: recordedAt.toISOString(),
          receivedAt: receivedAt.toISOString(),
          source: point.source,
          freshnessSeconds
        }
      },
      trailAppend: {
        id: historyId,
        latitude: point.latitude,
        longitude: point.longitude,
        speedKph: point.speedKph ?? null,
        heading: point.heading ?? null,
        recordedAt: recordedAt.toISOString(),
        source: point.source
      }
    };
  }

  private async resolveVehicle(client: PoolClient, point: TelemetryPoint) {
    if (point.vehicleId) {
      const deviceResult = await client.query<{ device_id: string | null }>(
        `
          SELECT id::text AS device_id
          FROM vehicle_tracking_device
          WHERE organization_id = $1
            AND vehicle_id = $2
            AND is_active = true
          LIMIT 1
        `,
        [point.organizationId, point.vehicleId]
      );

      return {
        vehicleId: point.vehicleId,
        deviceId: deviceResult.rows[0]?.device_id ?? null
      } satisfies ResolvedVehicle;
    }

    const mappingResult = await client.query<{
      vehicle_id: string;
      device_id: string;
    }>(
      `
        SELECT vehicle_id::text AS vehicle_id, id::text AS device_id
        FROM vehicle_tracking_device
        WHERE organization_id = $1
          AND external_device_id = $2
          AND is_active = true
        LIMIT 1
      `,
      [point.organizationId, point.externalDeviceId]
    );

    if (mappingResult.rowCount === 0) {
      throw new Error(
        `Missing active tracking mapping for externalDeviceId ${point.externalDeviceId} in organization ${point.organizationId}`
      );
    }

    return {
      vehicleId: mappingResult.rows[0].vehicle_id,
      deviceId: mappingResult.rows[0].device_id
    } satisfies ResolvedVehicle;
  }

  private async lookupRentalState(client: PoolClient, vehicleId: string) {
    const rentalTableName = await this.resolveRentalTableName(client);

    if (!rentalTableName) {
      return false;
    }

    const result = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${rentalTableName} WHERE vehicle_id = $1 AND status = ANY($2::text[])`,
      [vehicleId, ACTIVE_RENTAL_STATUSES]
    );

    return (result.rows[0]?.count ?? 0) > 0;
  }

  private async resolveRentalTableName(client: PoolClient) {
    if (this.rentalTableName !== undefined) {
      return this.rentalTableName;
    }

    const result = await client.query<{
      rental: string | null;
      rentals: string | null;
    }>(
      `
        SELECT
          to_regclass('public.rental')::text AS rental,
          to_regclass('public.rentals')::text AS rentals
      `
    );

    const row = result.rows[0];

    if (row?.rental === "public.rental") {
      this.rentalTableName = "public.rental";
      return this.rentalTableName;
    }

    if (row?.rentals === "public.rentals") {
      this.rentalTableName = "public.rentals";
      return this.rentalTableName;
    }

    this.rentalTableName = null;
    return this.rentalTableName;
  }
}
