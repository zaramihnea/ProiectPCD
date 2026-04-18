const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { ServiceBusClient } = require("@azure/service-bus");
const { v4: uuidv4 } = require("uuid");

const PORT = parseInt(process.env.PORT || "9000");
const LISTMONK_URL = process.env.LISTMONK_URL || "http://localhost:9001";
const SERVICEBUS_CONNECTION_STRING = process.env.SERVICEBUS_CONNECTION_STRING;
const TOPIC_NAME = process.env.TOPIC_NAME || "resource-events";

// Resources we want to track — maps URL prefix to resource type
const TRACKED_ROUTES = [
  { prefix: "/api/subscribers",          resource: "subscriber" },
  { prefix: "/api/campaigns",            resource: "campaign"   },
  { prefix: "/api/lists",                resource: "list"       },
  { prefix: "/api/templates",            resource: "template"   },
  { prefix: "/api/public/subscription",  resource: "subscriber" }, // public subscribe form
  { prefix: "/subscription",             resource: "subscriber" }, // legacy public form
];

// Service Bus sender — lazily initialised so the proxy still works if SB is unavailable
let sbSender = null;
if (SERVICEBUS_CONNECTION_STRING) {
  const sbClient = new ServiceBusClient(SERVICEBUS_CONNECTION_STRING);
  sbSender = sbClient.createSender(TOPIC_NAME);
} else {
  console.warn("SERVICEBUS_CONNECTION_STRING not set — events will not be published");
}

async function publishEvent(type, resourceType, resourceId, method) {
  if (!sbSender) return;
  try {
    const event = {
      eventId:      uuidv4(),          // idempotency key for the Azure Function
      type,                            // "resource_accessed" | "resource_created" etc.
      resourceType,                    // "subscriber" | "campaign" | "list" | "template"
      resourceId:   resourceId || null,
      method,                          // GET | POST | PUT | DELETE
      timestamp:    new Date().toISOString(),
    };
    await sbSender.sendMessages({ body: event, contentType: "application/json" });
    console.log(`[SB] published ${event.type} ${event.resourceType}${event.resourceId ? "/" + event.resourceId : ""}`);
  } catch (err) {
    // Non-fatal — proxy must never fail because of Service Bus
    console.error("Failed to publish event:", err.message);
  }
}

function extractResourceId(url, prefix) {
  // e.g. /api/subscribers/42  →  "42"
  const rest = url.slice(prefix.length).split("?")[0];
  const parts = rest.split("/").filter(Boolean);
  return parts[0] || null;
}

function eventTypeFromMethod(method) {
  const map = { GET: "resource_accessed", POST: "resource_created",
                PUT: "resource_updated", DELETE: "resource_deleted" };
  return map[method.toUpperCase()] || "resource_accessed";
}

const app = express();

// Publish event BEFORE proxying — fire-and-forget, never blocks the request
app.use((req, _res, next) => {
  const match = TRACKED_ROUTES.find(r => req.path.startsWith(r.prefix));
  if (match) {
    const resourceId = extractResourceId(req.path, match.prefix);
    const type = eventTypeFromMethod(req.method);
    publishEvent(type, match.resource, resourceId, req.method).catch(() => {});
  }
  next();
});

// Forward everything to Listmonk
app.use(
  "/",
  createProxyMiddleware({
    target: LISTMONK_URL,
    changeOrigin: true,
    ws: true, // forward WebSocket upgrades too
    on: {
      error: (err, _req, res) => {
        console.error("Proxy error:", err.message);
        if (!res.headersSent) res.status(502).json({ error: "Bad gateway" });
      },
    },
  })
);

app.listen(PORT, () => {
  console.log(`listmonk-proxy listening on :${PORT} → ${LISTMONK_URL}`);
  console.log(`Service Bus topic: ${TOPIC_NAME}`);
  console.log(`Tracking routes: ${TRACKED_ROUTES.map(r => r.prefix).join(", ")}`);
});
