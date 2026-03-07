# Codex Brief For Separate Telemetry Project

Use this brief in a separate Codex session when creating the external telemetry project.

## Request

Build a new standalone project called `rental-fleet-telemetry`.

## Requirements

- TypeScript + Express
- Node 20+
- PostgreSQL via `pg`
- `zod` validation
- `tsx` local runner
- SSE broadcast by organization
- Mock simulator with Melbourne routes
- Shared DB with the rental app

## Deliverables

1. `POST /ingest`
2. `GET /stream?organizationId=...`
3. `GET /health`
4. simulator CLI
5. route fixtures
6. README with env and run instructions

## Constraints

- The service must write to existing shared tables:
  - `vehicle_tracking_device`
  - `vehicle_live_position`
  - `vehicle_position_history`
- Resolve by `vehicleId` or `externalDeviceId`
- Use bearer-token auth for both `/ingest` and `/stream`
- Simulator must call the telemetry service, not the Next.js app

## Source Documents

- [docs/fleet-telemetry-service-spec.md](/Users/janith/Projects/ef/c/rental-app/docs/fleet-telemetry-service-spec.md)
- [docs/fleet-telemetry-service-simulator.md](/Users/janith/Projects/ef/c/rental-app/docs/fleet-telemetry-service-simulator.md)

## Acceptance Criteria

- `pnpm install` works
- `pnpm start` starts the gateway
- `pnpm simulate --scenario=default --tick-ms=2000 --vehicle-count=4` emits mock telemetry
- app fleet screen updates through SSE when simulator is running
