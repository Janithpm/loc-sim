import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSimulatorConfig } from "./config.js";
import {
  geoJsonRouteSchema,
  scenarioSchema,
  type GeoJsonRoute,
  type Scenario,
  type TelemetryPoint
} from "./types.js";

type CliOptions = {
  scenario: string;
  tickMs: number;
  vehicleCount: number;
  speedMultiplier: number;
};

type LoadedRoute = {
  id: string;
  name: string;
  coordinates: [number, number][];
  segmentLengths: number[];
  cumulativeDistances: number[];
  totalDistanceMeters: number;
};

type LoadedScenario = {
  routes: LoadedRoute[];
  routesById: Map<string, LoadedRoute>;
  vehicles?: Scenario["vehicles"];
};

type VehicleRuntimeState = {
  slot: number;
  route: LoadedRoute;
  speedKph: number;
  accuracyMeters: number;
  loop: boolean;
  distanceMeters: number;
};

function parseCliArgs(argv: string[]): CliOptions {
  const defaults: CliOptions = {
    scenario: "default",
    tickMs: 2000,
    vehicleCount: 4,
    speedMultiplier: 1
  };

  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith("--")) {
      continue;
    }

    const normalized = argument.slice(2);
    const [key, inlineValue] = normalized.split("=", 2);

    if (inlineValue !== undefined) {
      values.set(key, inlineValue);
      continue;
    }

    const nextValue = argv[index + 1];

    if (nextValue && !nextValue.startsWith("--")) {
      values.set(key, nextValue);
      index += 1;
      continue;
    }

    values.set(key, "true");
  }

  const tickMs = Number(values.get("tick-ms") ?? defaults.tickMs);
  const vehicleCount = Number(values.get("vehicle-count") ?? defaults.vehicleCount);
  const speedMultiplier = Number(
    values.get("speed-multiplier") ?? defaults.speedMultiplier
  );

  return {
    scenario: values.get("scenario") ?? defaults.scenario,
    tickMs: Number.isFinite(tickMs) && tickMs > 0 ? tickMs : defaults.tickMs,
    vehicleCount:
      Number.isInteger(vehicleCount) && vehicleCount > 0
        ? vehicleCount
        : defaults.vehicleCount,
    speedMultiplier:
      Number.isFinite(speedMultiplier) && speedMultiplier > 0
        ? speedMultiplier
        : defaults.speedMultiplier
  };
}

function interpolate(
  current: [number, number],
  next: [number, number],
  progress: number
) {
  return [
    current[0] + (next[0] - current[0]) * progress,
    current[1] + (next[1] - current[1]) * progress
  ] as const;
}

function calculateHeading(from: [number, number], to: [number, number]) {
  const longitudeDelta = ((to[0] - from[0]) * Math.PI) / 180;
  const fromLatitude = (from[1] * Math.PI) / 180;
  const toLatitude = (to[1] * Math.PI) / 180;

  const y = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const x =
    Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) *
      Math.cos(toLatitude) *
      Math.cos(longitudeDelta);

  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

function calculateDistanceMeters(
  from: [number, number],
  to: [number, number]
) {
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = ((to[1] - from[1]) * Math.PI) / 180;
  const longitudeDelta = ((to[0] - from[0]) * Math.PI) / 180;
  const fromLatitude = (from[1] * Math.PI) / 180;
  const toLatitude = (to[1] * Math.PI) / 180;

  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function loadJsonFile<T>(filePath: string, schema: { parse: (value: unknown) => T }) {
  const raw = await readFile(filePath, "utf8");
  return schema.parse(JSON.parse(raw));
}

async function loadScenario(projectRoot: string, scenarioName: string) {
  const scenarioPath = resolve(
    projectRoot,
    "fixtures",
    "scenarios",
    `${scenarioName}.json`
  );
  const scenario = await loadJsonFile(scenarioPath, scenarioSchema);

  const routes: LoadedRoute[] = [];

  for (const routeRef of scenario.routes) {
    const routePath = resolve(dirname(scenarioPath), routeRef.path);
    const route = await loadJsonFile(routePath, geoJsonRouteSchema);
    routes.push(normalizeRoute(routeRef.id, route));
  }

  const routesById = new Map(routes.map((route) => [route.id, route]));

  if (routesById.size !== routes.length) {
    throw new Error(`Scenario ${scenarioName} contains duplicate route ids.`);
  }

  for (const vehicle of scenario.vehicles ?? []) {
    if (!routesById.has(vehicle.routeId)) {
      throw new Error(
        `Scenario ${scenarioName} references missing routeId=${vehicle.routeId} for slot=${vehicle.slot}.`
      );
    }
  }

  return {
    routes,
    routesById,
    vehicles: scenario.vehicles
  } satisfies LoadedScenario;
}

function normalizeRoute(id: string, route: GeoJsonRoute): LoadedRoute {
  const segmentLengths: number[] = [];
  const cumulativeDistances: number[] = [];
  let totalDistanceMeters = 0;

  for (let index = 0; index < route.geometry.coordinates.length - 1; index += 1) {
    const length = calculateDistanceMeters(
      route.geometry.coordinates[index],
      route.geometry.coordinates[index + 1]
    );
    totalDistanceMeters += length;
    segmentLengths.push(length);
    cumulativeDistances.push(totalDistanceMeters);
  }

  return {
    id,
    name: route.properties.name,
    coordinates: route.geometry.coordinates,
    segmentLengths,
    cumulativeDistances,
    totalDistanceMeters
  };
}

function normalizeDistance(
  distanceMeters: number,
  totalDistanceMeters: number,
  loop: boolean
) {
  if (totalDistanceMeters <= 0) {
    return 0;
  }

  if (!loop) {
    return Math.min(distanceMeters, totalDistanceMeters);
  }

  return distanceMeters % totalDistanceMeters;
}

function getDefaultSpeedKph(slot: number) {
  return 24 + (slot - 1) * 4;
}

function buildVehicleStates(
  scenario: LoadedScenario,
  vehicleCount: number,
  speedMultiplier: number
) {
  if (scenario.vehicles && scenario.vehicles.length > 0) {
    return Array.from({ length: vehicleCount }, (_, index) => {
      const slot = index + 1;
      const vehicle = scenario.vehicles?.find((entry) => entry.slot === slot);

      if (!vehicle) {
        throw new Error(`Scenario is missing a vehicle route assignment for slot=${slot}.`);
      }

      const route = scenario.routesById.get(vehicle.routeId);

      if (!route) {
        throw new Error(`Scenario references missing routeId=${vehicle.routeId}.`);
      }

      return {
        slot,
        route,
        speedKph: (vehicle.speedKph ?? getDefaultSpeedKph(slot)) * speedMultiplier,
        accuracyMeters: vehicle.accuracyMeters,
        loop: vehicle.loop,
        distanceMeters: normalizeDistance(
          vehicle.startOffsetMeters,
          route.totalDistanceMeters,
          vehicle.loop
        )
      } satisfies VehicleRuntimeState;
    });
  }

  return Array.from({ length: vehicleCount }, (_, index) => {
    const route = scenario.routes[index % scenario.routes.length];
    const slot = index + 1;

    return {
      slot,
      route,
      speedKph: getDefaultSpeedKph(slot) * speedMultiplier,
      accuracyMeters: 6,
      loop: true,
      distanceMeters: 0
    } satisfies VehicleRuntimeState;
  });
}

function sampleRoutePosition(route: LoadedRoute, distanceMeters: number) {
  const clampedDistance = normalizeDistance(distanceMeters, route.totalDistanceMeters, false);
  const defaultNext = route.coordinates[1] ?? route.coordinates[0];

  if (route.segmentLengths.length === 0 || route.totalDistanceMeters === 0) {
    return {
      latitude: route.coordinates[0][1],
      longitude: route.coordinates[0][0],
      heading: Math.round(calculateHeading(route.coordinates[0], defaultNext)),
      routeProgressPct: 100
    };
  }

  let segmentIndex = route.cumulativeDistances.findIndex(
    (segmentDistance) => clampedDistance <= segmentDistance
  );

  if (segmentIndex === -1) {
    segmentIndex = route.segmentLengths.length - 1;
  }

  const segmentStartDistance =
    segmentIndex === 0 ? 0 : route.cumulativeDistances[segmentIndex - 1];
  const segmentLength = route.segmentLengths[segmentIndex];
  const current = route.coordinates[segmentIndex];
  const next = route.coordinates[segmentIndex + 1] ?? current;
  const progress =
    segmentLength === 0 ? 0 : (clampedDistance - segmentStartDistance) / segmentLength;
  const [longitude, latitude] = interpolate(current, next, progress);

  return {
    latitude,
    longitude,
    heading: Math.round(calculateHeading(current, next)),
    routeProgressPct: Number(
      ((clampedDistance / route.totalDistanceMeters) * 100).toFixed(2)
    )
  };
}

function buildTickPoints(
  vehicleStates: VehicleRuntimeState[],
  organizationId: string,
  vehicleIds: string[]
) {
  const recordedAt = new Date().toISOString();

  return vehicleStates.map((vehicleState) => {
    const sampledPosition = sampleRoutePosition(
      vehicleState.route,
      vehicleState.distanceMeters
    );
    const vehicleId = vehicleIds[vehicleState.slot - 1];
    const isComplete =
      !vehicleState.loop &&
      vehicleState.distanceMeters >= vehicleState.route.totalDistanceMeters;

    return {
      organizationId,
      vehicleId,
      latitude: sampledPosition.latitude,
      longitude: sampledPosition.longitude,
      recordedAt,
      speedKph: isComplete ? 0 : vehicleState.speedKph,
      heading: sampledPosition.heading,
      accuracyMeters: vehicleState.accuracyMeters,
      attributes: {
        routeId: vehicleState.route.id,
        routeName: vehicleState.route.name,
        routeLoop: vehicleState.loop,
        routeProgressPct: sampledPosition.routeProgressPct,
        simulatorSlot: vehicleState.slot
      },
      source: "mock" as const
    } satisfies TelemetryPoint;
  });
}

function advanceVehicleStates(
  vehicleStates: VehicleRuntimeState[],
  tickMs: number
) {
  for (const vehicleState of vehicleStates) {
    const distanceDeltaMeters = (vehicleState.speedKph * tickMs) / 3.6;
    const nextDistance = vehicleState.distanceMeters + distanceDeltaMeters;

    vehicleState.distanceMeters = normalizeDistance(
      nextDistance,
      vehicleState.route.totalDistanceMeters,
      vehicleState.loop
    );
  }
}

function sleep(durationMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function postPoints(
  gatewayUrl: string,
  gatewayToken: string,
  points: TelemetryPoint[]
) {
  const response = await fetch(new URL("/ingest", gatewayUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gatewayToken}`
    },
    body: JSON.stringify({ points })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gateway returned ${response.status}: ${body}`);
  }

  return response.json() as Promise<{ accepted: number }>;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const config = loadSimulatorConfig();
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const scenario = await loadScenario(projectRoot, cli.scenario);
  const vehicleStates = buildVehicleStates(
    scenario,
    cli.vehicleCount,
    cli.speedMultiplier
  );

  console.log(
    `Simulator started with scenario=${cli.scenario} tickMs=${cli.tickMs} vehicleCount=${cli.vehicleCount} speedMultiplier=${cli.speedMultiplier}`
  );

  let stopped = false;

  const stop = () => {
    stopped = true;
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let tick = 0;

  while (!stopped) {
    const activeVehicleIds = config.vehicleIds.slice(0, cli.vehicleCount);
    const missingVehicleMapping =
      activeVehicleIds.length < cli.vehicleCount ||
      activeVehicleIds.some((vehicleId) => vehicleId.length === 0);

    if (!config.organizationId || missingVehicleMapping) {
      console.warn(
        "Simulator skipped tick because SIM_ORGANIZATION_ID / SIM_VEHICLE_ID_* are missing."
      );
      } else {
        try {
          const points = buildTickPoints(
            vehicleStates,
            config.organizationId,
            activeVehicleIds
          );
          const result = await postPoints(
            config.gatewayUrl,
            config.gatewayToken,
            points
        );

        console.log(`Tick ${tick}: accepted ${result.accepted} points.`);
      } catch (error) {
        console.error(
          `Tick ${tick}: failed to deliver telemetry.`,
          error instanceof Error ? error.message : error
        );
      }
    }

    advanceVehicleStates(vehicleStates, cli.tickMs);
    tick += 1;

    if (!stopped) {
      await sleep(cli.tickMs);
    }
  }

  console.log("Simulator stopped.");
}

void main().catch((error) => {
  console.error("Simulator failed to start.", error);
  process.exit(1);
});
