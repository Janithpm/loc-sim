# rental-fleet-telemetry

Standalone telemetry gateway for the rental fleet app. It accepts normalized GPS telemetry, writes current and historical position data into the shared Postgres database, and broadcasts organization-scoped vehicle updates over SSE. A built-in simulator emits mock Melbourne routes into the gateway for demo and QA usage.

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
