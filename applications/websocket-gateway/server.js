const express = require('express');
const { WebSocketServer } = require('ws');
const { CosmosClient } = require('@azure/cosmos');
const http = require('http');

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

app.post('/notify', (req, res) => {
    const data = req.body;
    console.log('[NOTIFY] Received update:', data.resourceType);

    const payload = JSON.stringify(data);
    let count = 0;
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // 1 = OPEN
            client.send(payload);
            count++;
        }
    });

    console.log(`[WS] Broadcasted to ${count} clients`);
    res.status(200).send({ success: true, broadcastCount: count });
});

wss.on('connection', async (ws) => {
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
        console.log('[WS] Client disconnected');
    });
});

server.listen(PORT, () => {
    console.log(`WebSocket Gateway listening on port ${PORT}`);
});