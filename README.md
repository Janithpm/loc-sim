# rental-fleet-telemetry

Standalone telemetry gateway for the rental fleet app. It accepts normalized GPS telemetry, writes current and historical position data into the shared Postgres database, and broadcasts organization-scoped vehicle updates over SSE. A built-in simulator emits mock Melbourne routes into the gateway for demo and QA usage.

The simulator supports scenario-driven per-vehicle routes. Each simulator slot can be assigned its own GeoJSON route, speed, loop mode, and start offset.

## Environment

Create or update `.env` with:

```env
PORT=4100
DATABASE_URL=postgres://...
TELEMETRY_GATEWAY_TOKEN=shared-secret
SIM_GATEWAY_URL=http://localhost:4100
SIM_ORGANIZATION_ID=
SIM_VEHICLE_ID_1=
SIM_VEHICLE_ID_2=
SIM_VEHICLE_ID_3=
SIM_VEHICLE_ID_4=
```

Notes:

- `DATABASE_URL` must point to the same Postgres database used by the rental app.
- `TELEMETRY_GATEWAY_TOKEN` must match the app-side gateway token.
- Leave simulator IDs blank until you have real UUIDs from the shared app database.

## Commands

Install dependencies:

```bash
pnpm install
```

Start the telemetry gateway:

```bash
pnpm start
```

Run the simulator:

```bash
pnpm simulate --scenario=default --tick-ms=2000 --vehicle-count=4
```

## Scenario Routes

Scenario files live in `fixtures/scenarios/` and route files live in `fixtures/routes/`.

Routes use GeoJSON `Feature` + `LineString` with coordinates in `[longitude, latitude]` order.

Scenarios can keep using a shared `routes` list, and can now optionally add explicit per-slot vehicle assignments:

```json
{
  "routes": [
    { "id": "cbd-loop", "path": "../routes/cbd-loop.geojson" },
    { "id": "st-kilda-run", "path": "../routes/st-kilda-run.geojson" }
  ],
  "vehicles": [
    { "slot": 1, "routeId": "cbd-loop", "speedKph": 26, "startOffsetMeters": 0, "loop": true },
    { "slot": 2, "routeId": "st-kilda-run", "speedKph": 30, "startOffsetMeters": 350, "loop": true }
  ]
}
```

When `vehicles` is omitted, the simulator falls back to assigning routes round-robin by slot.

An external test scenario is included at `fixtures/scenarios/osrm-sample.json`. It uses a public OSRM route sample from Southbank to St Kilda so you can test multiple vehicles on the same real road path with different offsets.

A shorter external test scenario is included at `fixtures/scenarios/botanic-2km-40kph.json`. It uses a 2,021 m public OSRM route and sets all vehicle slots to `40` km/h.

For 5-10 m spacing between GPS points at `40` km/h, run the simulator with:

```bash
pnpm simulate --scenario=botanic-2km-40kph --tick-ms=500 --vehicle-count=4
```

`500 ms` yields about `5.56 m` between points. The usable range is `450-900 ms`:

- `450 ms` -> `5.00 m`
- `500 ms` -> `5.56 m`
- `750 ms` -> `8.33 m`
- `900 ms` -> `10.00 m`

## API

- `GET /health`
- `GET /stream?organizationId=<uuid>`
- `POST /ingest`

Both `/stream` and `/ingest` require `Authorization: Bearer <TELEMETRY_GATEWAY_TOKEN>`.

## App Integration

The rental app should continue pointing at this external gateway:

```env
TELEMETRY_GATEWAY_URL=http://localhost:4100
TELEMETRY_GATEWAY_TOKEN=shared-secret
```
