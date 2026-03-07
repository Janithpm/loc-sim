import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSimulatorConfig } from "./config.js";
import {
  geoJsonRouteSchema,
  scenarioSchema,
  type GeoJsonRoute,
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
  coordinates: [number, number][],
  segmentIndex: number,
  progress: number
) {
  const current = coordinates[segmentIndex];
  const next = coordinates[(segmentIndex + 1) % coordinates.length];

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

async function loadJsonFile<T>(filePath: string, schema: { parse: (value: unknown) => T }) {
  const raw = await readFile(filePath, "utf8");
  return schema.parse(JSON.parse(raw));
}

async function loadRoutes(projectRoot: string, scenarioName: string) {
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

  return routes;
}

function normalizeRoute(id: string, route: GeoJsonRoute): LoadedRoute {
  return {
    id,
    name: route.properties.name,
    coordinates: route.geometry.coordinates
  };
}

function buildTickPoints(
  tick: number,
  routes: LoadedRoute[],
  organizationId: string,
  vehicleIds: string[],
  speedMultiplier: number
) {
  const recordedAt = new Date().toISOString();

  return vehicleIds.map((vehicleId, index) => {
    const route = routes[index % routes.length];
    const segmentIndex = tick % (route.coordinates.length - 1);
    const progress = ((tick * speedMultiplier) % 10) / 10;
    const [longitude, latitude] = interpolate(
      route.coordinates,
      segmentIndex,
      progress
    );
    const current = route.coordinates[segmentIndex];
    const next = route.coordinates[(segmentIndex + 1) % route.coordinates.length];

    return {
      organizationId,
      vehicleId,
      latitude,
      longitude,
      recordedAt,
      speedKph: 24 + index * 4 + Math.round(progress * 10),
      heading: Math.round(calculateHeading(current, next)),
      accuracyMeters: 6,
      attributes: {
        routeId: route.id,
        routeName: route.name
      },
      source: "mock" as const
    } satisfies TelemetryPoint;
  });
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
  const routes = await loadRoutes(projectRoot, cli.scenario);

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
          tick,
          routes,
          config.organizationId,
          activeVehicleIds,
          cli.speedMultiplier
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
