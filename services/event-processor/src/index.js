const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

// Cosmos DB client - reused across invocations (warm start optimisation)
const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY,
});

const database = cosmosClient.database(process.env.COSMOS_DATABASE);
const eventsContainer = database.container(process.env.COSMOS_CONTAINER);

// Aggregated stats container - same DB, different container
const statsContainer = database.container("stats");

const COUNTER_BY_EVENT_TYPE = {
  resource_accessed: "totalAccesses",
  resource_created: "totalCreated",
  resource_updated: "totalUpdated",
  resource_deleted: "totalDeleted",
};

function isCosmosStatus(err, statusCode) {
  return err?.code === statusCode || err?.statusCode === statusCode;
}

async function storeRawEventOnce(event) {
  const { eventId, type, resourceType, resourceId, method, timestamp } = event;

  try {
    await eventsContainer.items.create({
      id: eventId,
      eventId,
      type,
      resourceType,
      resourceId: resourceId || null,
      method,
      timestamp,
      processedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    if (isCosmosStatus(err, 409)) {
      return false;
    }
    throw err;
  }
}

async function removeRawEvent(event) {
  const { eventId, resourceType } = event;

  await eventsContainer
    .item(eventId, resourceType)
    .delete()
    .catch((err) => {
      if (!isCosmosStatus(err, 404)) {
        throw err;
      }
    });
}

function newestTimestamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

async function updateStatsWithRetry(event, maxAttempts = 10) {
  const { type, resourceType, timestamp } = event;
  const counterField = COUNTER_BY_EVENT_TYPE[type];

  if (!counterField) {
    return null;
  }

  const statsId = `stats-${resourceType}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { resource: existing } = await statsContainer
      .item(statsId, resourceType)
      .read()
      .catch((err) => {
        if (isCosmosStatus(err, 404)) return { resource: null };
        throw err;
      });

    const stats = {
      id: statsId,
      resourceType,
      totalAccesses: existing?.totalAccesses || 0,
      totalCreated: existing?.totalCreated || 0,
      totalUpdated: existing?.totalUpdated || 0,
      totalDeleted: existing?.totalDeleted || 0,
      lastEventAt: newestTimestamp(existing?.lastEventAt, timestamp),
    };

    stats[counterField] += 1;

    try {
      if (!existing) {
        const { resource } = await statsContainer.items.create(stats);
        return resource;
      }

      const { resource } = await statsContainer
        .item(statsId, resourceType)
        .replace(stats, {
          accessCondition: {
            type: "IfMatch",
            condition: existing._etag,
          },
        });
      return resource;
    } catch (err) {
      if (isCosmosStatus(err, 409) || isCosmosStatus(err, 412)) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to update stats for ${resourceType} after ${maxAttempts} attempts`);
}

app.serviceBusTopic("processResourceEvent", {
  topicName: process.env.SERVICEBUS_TOPIC || "resource-events",
  subscriptionName: process.env.SERVICEBUS_SUBSCRIPTION || "event-processor",
  connection: "SERVICEBUS_CONNECTION_STRING",
  handler: async (message, context) => {
    context.log("Processing event:", JSON.stringify(message));

    const event = typeof message === "string" ? JSON.parse(message) : message;
    const { eventId, type, resourceType, resourceId, method, timestamp } = event;

    if (!eventId) {
      context.warn("Event missing eventId, skipping");
      return;
    }

    // ── Idempotency check ────────────────────────────────────────────────────
    // Service Bus is at-least-once. Creating the raw event first lets duplicate
    // deliveries fail with 409 before they can increment aggregate counters.

    // ── 1. Store raw event ───────────────────────────────────────────────────
    const stored = await storeRawEventOnce(event);
    if (!stored) {
      context.log(`Duplicate event skipped: ${eventId}`);
      return;
    }

    // ── 2. Update aggregated stats ───────────────────────────────────────────
    let stats;
    try {
      stats = await updateStatsWithRetry(event);
    } catch (err) {
      await removeRawEvent(event);
      throw err;
    }

    // ── 3. Notify WebSocket Gateway (fire-and-forget) ────────────────────────
    const wsUrl = process.env.WEBSOCKET_NOTIFY_URL;
    if (wsUrl && stats) {
      try {
        const body = JSON.stringify({ type: "stats_updated", resourceType, stats });
        await fetch(wsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(3000),
        });
      } catch (err) {
        // Non-fatal - WebSocket Gateway may not be up yet
        context.warn("Failed to notify WebSocket Gateway:", err.message);
      }
    }

    if (stats) {
      context.log(`Done: ${type} ${resourceType} - stats: created=${stats.totalCreated} accessed=${stats.totalAccesses}`);
    } else {
      context.log(`Done: ${type} ${resourceType} - no aggregate counter configured`);
    }
  },
});
