# Fleet Telemetry Service Spec

This document describes the separate telemetry gateway that should live outside this app repo.

The main app in this repo already expects an external service via:

- `TELEMETRY_GATEWAY_URL`
- `TELEMETRY_GATEWAY_TOKEN`

The app consumes that external service through:

- `GET /api/fleet/live/stream` proxying upstream SSE
- the `vehicle_live_position`, `vehicle_position_history`, and `vehicle_tracking_device` tables in the shared database

## Goal

Build a separate TypeScript + Express service named `rental-fleet-telemetry` that:

1. Accepts normalized GPS telemetry payloads
2. Resolves incoming points to vehicles
3. Writes current position + history into the shared app database
4. Broadcasts updates over SSE by organization
5. Runs a mock simulator for demo/QA

## Runtime

- Node.js 20+
- TypeScript
- Express
- `pg` for direct SQL access
- `zod` for request validation
- `tsx` for local execution

## Package Manifest

Use this `package.json`:

```json
{
  "name": "rental-fleet-telemetry",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "simulate": "tsx src/simulator.ts"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^17.3.1",
    "express": "^4.21.2",
    "pg": "^8.16.3",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.3",
    "@types/node": "^24.0.0",
    "@types/pg": "^8.15.5",
    "tsx": "^4.20.6",
    "typescript": "^5.9.3"
  }
}
```

## TypeScript Config

Use this `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "fixtures/**/*.json"]
}
```

## Environment

Create `.env` with:

```env
PORT=4100
DATABASE_URL=postgres://...
TELEMETRY_GATEWAY_TOKEN=shared-secret
SIM_GATEWAY_URL=http://localhost:4100
SIM_ORGANIZATION_ID=org-uuid
SIM_VEHICLE_ID_1=vehicle-uuid-1
SIM_VEHICLE_ID_2=vehicle-uuid-2
SIM_VEHICLE_ID_3=vehicle-uuid-3
SIM_VEHICLE_ID_4=vehicle-uuid-4
```

Notes:

- `DATABASE_URL` must point to the same Postgres database used by the app.
- `TELEMETRY_GATEWAY_TOKEN` must match the app-side `TELEMETRY_GATEWAY_TOKEN`.
- `SIM_ORGANIZATION_ID` and `SIM_VEHICLE_ID_*` are only needed for the simulator.

## Expected Project Layout

```text
rental-fleet-telemetry/
  package.json
  tsconfig.json
  .env
  README.md
  fixtures/
    routes/
      cbd-loop.geojson
      st-kilda-run.geojson
    scenarios/
      default.json
  src/
    broker.ts
    config.ts
    server.ts
    simulator.ts
    store.ts
    types.ts
```

## API Surface

### `GET /health`

Response:

```json
{
  "ok": true,
  "service": "rental-fleet-telemetry"
}
```

### `GET /stream?organizationId=<uuid>`

Purpose:

- SSE stream for frontend/app proxy consumption
- Emits organization-scoped telemetry updates

Auth:

- Require `Authorization: Bearer <TELEMETRY_GATEWAY_TOKEN>`

Headers:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `Connection: keep-alive`

Initial write:

```text
: connected

```

### `POST /ingest`

Purpose:

- Accept one or more telemetry points
- Persist history
- Upsert live position
- Publish SSE update

Auth:

- Require `Authorization: Bearer <TELEMETRY_GATEWAY_TOKEN>`

Request body:

```json
{
  "points": [
    {
      "organizationId": "uuid",
      "vehicleId": "uuid",
      "latitude": -37.8136,
      "longitude": 144.9631,
      "recordedAt": "2026-03-07T10:00:00.000Z",
      "speedKph": 42,
      "heading": 120,
      "accuracyMeters": 6,
      "attributes": {
        "routeId": "cbd-loop"
      },
      "source": "mock"
    }
  ]
}
```

Rules:

- Each point must include either `vehicleId` or `externalDeviceId`
- `source` is `"mock"` or `"traccar"`
- Validate with `zod`

Success response:

```json
{
  "accepted": 1
}
```

## Validation Types

Use these schemas:

```ts
import { z } from "zod"

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
  })

export const telemetryPayloadSchema = z.object({
  points: z.array(telemetryPointSchema).min(1)
})
```

## Database Contract

The service writes into these shared tables that already exist in the app database:

### `vehicle_tracking_device`

Used to resolve `externalDeviceId` to an internal vehicle when `vehicleId` is not sent directly.

### `vehicle_live_position`

Upsert one latest row per vehicle:

- `organization_id`
- `vehicle_id`
- `device_id`
- `latitude`
- `longitude`
- `speed_kph`
- `heading`
- `accuracy_meters`
- `recorded_at`
- `received_at`
- `source`
- `attributes_json`

Conflict key:

- `(organization_id, vehicle_id)`

### `vehicle_position_history`

Append every accepted point:

- same data fields as live position
- no upsert

## Persistence Flow

For each point:

1. Resolve target vehicle
2. Insert into `vehicle_position_history`
3. Upsert into `vehicle_live_position`
4. Check if vehicle is currently rented:
   - count rentals where `status in ('scheduled', 'active')`
5. Compute telemetry status:
   - `offline` if point older than 30 minutes
   - `moving` if point age <= 2 minutes and `speedKph >= 8`
   - otherwise `parked`
6. Publish SSE event

## Vehicle Resolution

When `vehicleId` exists:

- use it directly

When only `externalDeviceId` exists:

- query `vehicle_tracking_device`
- require matching:
  - `organization_id`
  - `external_device_id`
  - `is_active = true`

If no mapping exists:

- return server error for now
- message should mention missing active tracking mapping

## SSE Event Shape

Publish this payload:

```json
{
  "type": "vehicle.position.updated",
  "organizationId": "uuid",
  "vehicleId": "uuid",
  "snapshot": {
    "telemetryStatus": "moving",
    "isRentedNow": true,
    "position": {
      "latitude": -37.81,
      "longitude": 144.96,
      "speedKph": 42,
      "heading": 120,
      "accuracyMeters": 6,
      "recordedAt": "2026-03-07T10:00:00.000Z",
      "receivedAt": "2026-03-07T10:00:01.000Z",
      "source": "mock",
      "freshnessSeconds": 0
    }
  },
  "trailAppend": {
    "id": "uuid",
    "latitude": -37.81,
    "longitude": 144.96,
    "speedKph": 42,
    "heading": 120,
    "recordedAt": "2026-03-07T10:00:00.000Z",
    "source": "mock"
  }
}
```

## Broker Design

Keep an in-memory subscriber set:

- key fields:
  - `organizationId`
  - Express `Response`

Functions:

- `registerSubscriber(organizationId, response)`
- `publishEvent(event)`

Only publish to subscribers whose `organizationId` matches the event.

## Express Server Behavior

Use:

- `cors()`
- `express.json({ limit: "1mb" })`

Routes:

- `GET /health`
- `GET /stream`
- `POST /ingest`

Shutdown:

- handle `SIGINT`
- handle `SIGTERM`
- close HTTP server and PG pool

## README Content

Include:

- what the service does
- env vars
- `pnpm install`
- `pnpm start`
- `pnpm simulate --scenario=default --tick-ms=2000 --vehicle-count=4`
- note that the database must be shared with the app

## App Integration Reminder

In the main app repo, keep these env values configured:

```env
TELEMETRY_GATEWAY_URL=http://localhost:4100
TELEMETRY_GATEWAY_TOKEN=shared-secret
```

The app already expects the external gateway. No app-side mock server code is needed.
