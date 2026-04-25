const express = require('express');
const { WebSocketServer } = require('ws');
const { CosmosClient } = require('@azure/cosmos');
const http = require('http');
const promClient = require('prom-client');

promClient.collectDefaultMetrics();

const consistencyWindow = new promClient.Histogram({
  name: 'consistency_window_milliseconds',
  help: 'Time from proxy publish to WebSocket Gateway notify (ms)',
  buckets: [50, 100, 150, 200, 300, 500, 1000, 2000, 5000, 10000, 20000],
  labelNames: ['resourceType'],
});

const wsConnections = new promClient.Gauge({
  name: 'websocket_active_connections',
  help: 'Number of active WebSocket connections',
});

const PORT = process.env.PORT || 8080;

const cosmosClient = new CosmosClient({
    endpoint: process.env.COSMOS_ENDPOINT,
    key: process.env.COSMOS_KEY
});
const database = cosmosClient.database('analytics');
const statsContainer = database.container('stats');

const app = express();
app.use(express.json());

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

app.get('/ping', (req, res) => res.send('pong'));

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.send(await promClient.register.metrics());
});

app.post('/notify', (req, res) => {
    const data = req.body;
    const receivedAt = Date.now();

    // Consistency window = time from proxy publish (lastEventAt) to gateway notify
    if (data.stats?.lastEventAt) {
        const publishedAt = new Date(data.stats.lastEventAt).getTime();
        const windowMs = receivedAt - publishedAt;
        console.log(`[CONSISTENCY] window=${windowMs}ms resourceType=${data.resourceType}`);
        consistencyWindow.observe({ resourceType: data.resourceType }, windowMs);
    }

    console.log('[NOTIFY] Received update:', data.resourceType);

    const payload = JSON.stringify(data);
    let count = 0;
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(payload);
            count++;
        }
    });

    console.log(`[WS] Broadcasted to ${count} clients`);
    res.status(200).send({ success: true, broadcastCount: count });
});

wss.on('connection', async (ws) => {
    wsConnections.inc();
    console.log('[WS] New client connected');

    try {
        const { resources } = await statsContainer.items.readAll().fetchAll();
        ws.send(JSON.stringify({
            type: 'initial_state',
            data: resources
        }));
    } catch (err) {
        console.error('[COSMOS] Error fetching initial stats:', err.message);
    }

    ws.on('close', () => {
        wsConnections.dec();
        console.log('[WS] Client disconnected');
    });
});

server.listen(PORT, () => {
    console.log(`WebSocket Gateway listening on port ${PORT}`);
});