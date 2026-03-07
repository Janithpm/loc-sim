# Fleet Telemetry Simulator

This document contains the mock route fixtures and simulator behavior for the separate telemetry project.

## Purpose

The simulator should continuously emit realistic vehicle telemetry to the telemetry gateway by calling:

- `POST /ingest`

It should not call the Next.js app directly.

## CLI

Support these flags:

```bash
pnpm simulate --scenario=default --tick-ms=2000 --vehicle-count=4 --speed-multiplier=1
```

Defaults:

- `scenario=default`
- `tick-ms=2000`
- `vehicle-count=4`
- `speed-multiplier=1`

## Runtime Inputs

Environment variables:

- `SIM_ORGANIZATION_ID`
- `SIM_VEHICLE_ID_1`
- `SIM_VEHICLE_ID_2`
- `SIM_VEHICLE_ID_3`
- `SIM_VEHICLE_ID_4`
- `SIM_GATEWAY_URL`
- `TELEMETRY_GATEWAY_TOKEN`

Skip ticks if:

- `SIM_ORGANIZATION_ID` is empty
- any selected simulated slot has no mapped vehicle ID

Recommended warning:

```text
Simulator skipped tick because SIM_ORGANIZATION_ID / SIM_VEHICLE_ID_* are missing.
```

## Scenario File

Create `fixtures/scenarios/default.json`:

```json
{
  "routes": [
    {
      "id": "cbd-loop",
      "path": "../routes/cbd-loop.geojson"
    },
    {
      "id": "st-kilda-run",
      "path": "../routes/st-kilda-run.geojson"
    }
  ]
}
```

## GeoJSON Route: CBD Loop

Create `fixtures/routes/cbd-loop.geojson`:

```json
{
  "type": "Feature",
  "properties": {
    "id": "cbd-loop",
    "name": "Melbourne CBD Loop"
  },
  "geometry": {
    "type": "LineString",
    "coordinates": [
      [144.9593, -37.8171],
      [144.9662, -37.815],
      [144.9729, -37.8102],
      [144.9715, -37.8042],
      [144.9644, -37.8021],
      [144.9561, -37.8064],
      [144.9553, -37.8128],
      [144.9593, -37.8171]
    ]
  }
}
```

## GeoJSON Route: St Kilda Run

Create `fixtures/routes/st-kilda-run.geojson`:

```json
{
  "type": "Feature",
  "properties": {
    "id": "st-kilda-run",
    "name": "St Kilda Foreshore Run"
  },
  "geometry": {
    "type": "LineString",
    "coordinates": [
      [144.9631, -37.8136],
      [144.9699, -37.8216],
      [144.9734, -37.8357],
      [144.9769, -37.8486],
      [144.9805, -37.8609],
      [144.9754, -37.8644],
      [144.9683, -37.8507],
      [144.9631, -37.8136]
    ]
  }
}
```

## Simulation Logic

For each tick:

1. Load active routes from the chosen scenario
2. Assign vehicles to routes by index modulo route count
3. Compute:
   - `segmentIndex = tick % (coordinates.length - 1)`
   - `progress = ((tick * speedMultiplier) % 10) / 10`
4. Interpolate between current segment endpoints
5. Emit a normalized ingest point per active vehicle

Suggested interpolation helper:

```ts
function interpolate(
  coordinates: [number, number][],
  segmentIndex: number,
  progress: number,
) {
  const current = coordinates[segmentIndex]
  const next = coordinates[(segmentIndex + 1) % coordinates.length]

  return [
    current[0] + (next[0] - current[0]) * progress,
    current[1] + (next[1] - current[1]) * progress,
  ] as const
}
```

## Example Emitted Point

```json
{
  "organizationId": "org-uuid",
  "vehicleId": "vehicle-uuid-1",
  "latitude": -37.8136,
  "longitude": 144.9631,
  "recordedAt": "2026-03-07T10:00:00.000Z",
  "speedKph": 28,
  "heading": 72,
  "accuracyMeters": 6,
  "attributes": {
    "routeId": "cbd-loop",
    "routeName": "Melbourne CBD Loop"
  },
  "source": "mock"
}
```

## HTTP Call

POST to:

```text
${SIM_GATEWAY_URL}/ingest
```

Headers:

```http
Content-Type: application/json
Authorization: Bearer <TELEMETRY_GATEWAY_TOKEN>
```

Body:

```json
{
  "points": [
    {
      "organizationId": "org-uuid",
      "vehicleId": "vehicle-uuid-1",
      "latitude": -37.8136,
      "longitude": 144.9631,
      "recordedAt": "2026-03-07T10:00:00.000Z",
      "speedKph": 28,
      "heading": 72,
      "accuracyMeters": 6,
      "attributes": {
        "routeId": "cbd-loop",
        "routeName": "Melbourne CBD Loop"
      },
      "source": "mock"
    }
  ]
}
```

## Recommended File Responsibilities

### `src/config.ts`

- load env
- expose port, DB URL, token, simulator URL

### `src/types.ts`

- zod schemas
- TypeScript event contracts

### `src/broker.ts`

- subscriber registry
- event publishing

### `src/store.ts`

- PG pool
- device resolution
- history insert
- live-position upsert
- rental-state lookup
- event construction

### `src/server.ts`

- Express routes
- auth
- shutdown handling

### `src/simulator.ts`

- arg parsing
- scenario loading
- route loading
- interpolation
- ingest loop
