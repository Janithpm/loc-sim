import type { Response } from "express";

import type { TelemetryEvent } from "./types.js";

type Subscriber = {
  organizationId: string;
  response: Response;
  heartbeat: NodeJS.Timeout;
};

const subscribers = new Set<Subscriber>();

function unregister(subscriber: Subscriber) {
  clearInterval(subscriber.heartbeat);
  subscribers.delete(subscriber);
}

export function registerSubscriber(
  organizationId: string,
  response: Response
) {
  const subscriber: Subscriber = {
    organizationId,
    response,
    heartbeat: setInterval(() => {
      if (!response.writableEnded) {
        response.write(`: keepalive ${Date.now()}\n\n`);
      }
    }, 25_000)
  };

  subscribers.add(subscriber);

  return () => {
    unregister(subscriber);
  };
}

export function publishEvent(event: TelemetryEvent) {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

  for (const subscriber of subscribers) {
    if (subscriber.organizationId !== event.organizationId) {
      continue;
    }

    try {
      subscriber.response.write(payload);
    } catch {
      unregister(subscriber);
    }
  }
}

export function shutdownBroker() {
  for (const subscriber of subscribers) {
    clearInterval(subscriber.heartbeat);

    if (!subscriber.response.writableEnded) {
      subscriber.response.end();
    }

    subscribers.delete(subscriber);
  }
}
