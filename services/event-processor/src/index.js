const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

// Cosmos DB client — reused across invocations (warm start optimisation)
const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY,
});

const database = cosmosClient.database(process.env.COSMOS_DATABASE);
const eventsContainer = database.container(process.env.COSMOS_CONTAINER);

// Aggregated stats container — same DB, different container
const statsContainer = database.container("stats");

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
    // Cosmos DB upsert with eventId as the document id is inherently idempotent:
    // if the same eventId arrives twice (Service Bus at-least-once), the second
    // write just overwrites the identical document — no duplicate side-effects.

    // ── 1. Store raw event ───────────────────────────────────────────────────
    await eventsContainer.items.upsert({
      id: eventId,
      eventId,
      type,
      resourceType,
      resourceId: resourceId || null,
      method,
      timestamp,
      processedAt: new Date().toISOString(),
    });

    // ── 2. Update aggregated stats ───────────────────────────────────────────
    const statsId = `stats-${resourceType}`;
    const { resource: existing } = await statsContainer.item(statsId, statsId).read().catch(() => ({ resource: null }));

    const stats = existing || {
      id: statsId,
      resourceType,
      totalAccesses: 0,
      totalCreated: 0,
      totalUpdated: 0,
      totalDeleted: 0,
      lastEventAt: null,
    };

    if (type === "resource_accessed") stats.totalAccesses += 1;
    else if (type === "resource_created") stats.totalCreated += 1;
    else if (type === "resource_updated") stats.totalUpdated += 1;
    else if (type === "resource_deleted") stats.totalDeleted += 1;

    stats.lastEventAt = timestamp;

    await statsContainer.items.upsert(stats);

    // ── 3. Notify WebSocket Gateway (fire-and-forget) ────────────────────────
    const wsUrl = process.env.WEBSOCKET_NOTIFY_URL;
    if (wsUrl) {
      try {
        const body = JSON.stringify({ type: "stats_updated", resourceType, stats });
        await fetch(wsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(3000),
        });
      } catch (err) {
        // Non-fatal — WebSocket Gateway may not be up yet
        context.warn("Failed to notify WebSocket Gateway:", err.message);
      }
    }

    context.log(`Done: ${type} ${resourceType} — stats: created=${stats.totalCreated} accessed=${stats.totalAccesses}`);
  },
});
