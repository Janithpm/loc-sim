import type { NextFunction, Request, Response } from "express";

import cors from "cors";
import express from "express";

import { publishEvent, registerSubscriber, shutdownBroker } from "./broker.js";
import { loadServerConfig } from "./config.js";
import { TelemetryStore } from "./store.js";
import { streamQuerySchema, telemetryPayloadSchema } from "./types.js";

const config = loadServerConfig();
const store = new TelemetryStore(config.databaseUrl);
const app = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function requireBearerToken(
  request: Request,
  response: Response,
  next: NextFunction
) {
  const authHeader = request.header("authorization");
  const expected = `Bearer ${config.gatewayToken}`;

  if (authHeader !== expected) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "rental-fleet-telemetry"
  });
});

app.get("/stream", requireBearerToken, (request, response) => {
  const parsedQuery = streamQuerySchema.safeParse(request.query);

  if (!parsedQuery.success) {
    response.status(400).json({
      error: "Invalid organizationId",
      issues: parsedQuery.error.issues
    });
    return;
  }

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();
  response.write(": connected\n\n");
  response.socket?.setKeepAlive(true);

  const unregister = registerSubscriber(parsedQuery.data.organizationId, response);

  request.on("close", () => {
    unregister();
  });
});

app.post("/ingest", requireBearerToken, async (request, response, next) => {
  const parsedBody = telemetryPayloadSchema.safeParse(request.body);

  if (!parsedBody.success) {
    response.status(400).json({
      error: "Invalid telemetry payload",
      issues: parsedBody.error.issues
    });
    return;
  }

  try {
    const events = await store.ingestPoints(parsedBody.data.points);

    for (const event of events) {
      publishEvent(event);
    }

    response.json({
      accepted: events.length
    });
  } catch (error) {
    next(error);
  }
});

app.use(
  (
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction
  ) => {
    const message =
      error instanceof Error ? error.message : "Unexpected server error";

    response.status(500).json({
      error: message
    });
  }
);

const server = app.listen(config.port, () => {
  console.log(`Telemetry gateway listening on port ${config.port}`);
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down telemetry gateway.`);
  shutdownBroker();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  } catch (error) {
    console.error("Failed to close HTTP server cleanly.", error);
  }

  try {
    await store.close();
  } catch (error) {
    console.error("Failed to close Postgres pool cleanly.", error);
  }

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
