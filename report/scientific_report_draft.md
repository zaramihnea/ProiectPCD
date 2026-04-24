# Real-Time Analytics Dashboard: A distributed system for event driven resource access monitoring

**Team members:** Zara Mihnea-Tudor, Roman Iulian, Mihoc Roxana-Gabriela

**Repository:** [https://github.com/zaramihnea/ProiectPCD](https://github.com/zaramihnea/ProiectPCD)

## 1. Introduction

This report presents the design, implementation, and evaluation of a cloud-native distributed system developed to fulfill the requirements of building a real-time analytics pipeline. The system augments an existing REST API (Listmonk), an open-source newsletter manager (acting as the base application) with real-time analytics without modifying its core codebase. We capture resource-access events through a reverse proxy, process them asynchronously via a serverless component, aggregate statistics in a managed NoSQL store, and stream updates to connected clients over WebSockets.

The platform is deployed entirely on Microsoft Azure, leveraging AKS, Azure Functions, Azure Service Bus, and Cosmos DB. We analyze the system's architecture, communication patterns, and eventual consistency model (CAP theorem), followed by an empirical performance evaluation measuring end-to-end latency, throughput, consistency windows, and failure recovery using k6.

## 2. System Architecture

### 2.1 Overview

The system follows an **event-driven architecture** with clear separation between the *transactional path* (user interacts with Listmonk) and the *analytics path* (events flow through a pipeline to a live dashboard). The two paths are decoupled by Azure Service Bus, which provides durable at-least-once message delivery. To achieve this in a cloud-native Azure environment, we mapped the assignment's architectural requirements to the following specific technologies:

**1. Service A & Event Interception (Listmonk Proxy):**
To monitor resource usage without modifying Listmonk's core Go/PostgreSQL codebase, we deployed a Node.js proxy on AKS. For each incoming HTTP request, it inspects the path against tracked routes (e.g., `/api/subscribers`, `/api/campaigns`). On a match, it publishes a structured event containing a UUID (`eventId`), resource type, HTTP method and a timestamp. The publish is **fire-and-forget**: if the message broker is unreachable, the request still proxies through to Listmonk. This guarantees that analytics instrumentation can never degrade the availability or latency of the underlying application.

**2. Message Broker (Azure Service Bus):**
It acts as the asynchronous buffer between the proxy and the analytics engine. By receiving events on the `resource-events` topic, it absorbs sudden traffic spikes, ensuring the analytics pipeline processes data at its own pace without exerting backpressure on the main proxy.

**3. FaaS Event Processor (Azure Function):**
A serverless Node.js function triggered by the Service Bus. For each message, it performs three operations:

* **Idempotent Storage:** Upserts the raw event into Cosmos DB using the `eventId` as the document identifier. Because the Service Bus guarantees "at-least-once" delivery, duplicate messages safely overwrite identical data without causing duplicate statistics.
* **Aggregation:** Reads the current aggregate document, increments the relevant counter (`totalAccesses`, `totalCreated`, etc.), and writes it back.
* **Notification:** Issues a best-effort HTTP POST to the WebSocket Gateway's `/notify` endpoint with a strict three-second timeout, ensuring a slow gateway cannot starve the function's execution thread.

**4. Stateful Database (Azure Cosmos DB):**
A serverless NoSQL datastore that acts as the single source of truth, persisting both the raw event logs (in the `events` container) and the aggregated statistics (in the `stats` container).

**5. WebSocket Gateway & Dashboard (AKS):**
The WebSocket Gateway exposes `/ws` for client connections and `/notify` for the Event Processor. Upon a new client connection, it queries Cosmos DB for the `initial_state` and pushes it to the client, subsequently broadcasting live `/notify` payloads. The gateway is stateless regarding durable data, but stateful regarding live WebSocket connections. The frontend is a static browser client that renders the statistics and implements a reconnection strategy to recover from network drops.

!!!!!

!!!!![FA MIHNEA O DIAGRAMA CU APLICATIA (INSPIRATA DUPA AIA DIN ASSIGNMENT PDF)]

!!!!!

![resources](resources.png)

### 2.2 Infrastructure Automation and Observability

To ensure a reproducible, production-grade environment, the entire cloud footprint is provisioned declaratively.

* **Infrastructure as Code (IaC):** All underlying Azure resources are provisioned using **Terraform 1.5**. This includes the AKS cluster (configured with isolated system and user node pools for stability), the Azure Container Registry (ACR), the Service Bus namespace (Standard SKU), the Cosmos DB serverless account, and the Linux Function App.
* **Kubernetes Orchestration:** Application deployments are managed via **Helmfile**. This declarative approach orchestrates the deployment of our custom microservices alongside critical cluster add-ons.
* **Networking & Security:** We utilize **Traefik** as the Kubernetes Gateway implementation to route traffic, paired with **cert-manager** to automatically provision Let's Encrypt TLS certificates for our custom domain (`proiectpcd.online`).
* **Observability:** The `kube-prometheus-stack` is deployed to capture deep cluster metrics. This proved essential for identifying scaling behaviors, CPU utilization, and system bottlenecks during our load testing phases.

---

## 3. Communication Analysis — Synchronous vs. Asynchronous

| # | Interaction | Style | Protocol | Justification |
| --- | --- | --- | --- | --- |
| 1 | Browser → Proxy | Sync | HTTP/1.1 | The user is waiting; request–response semantics are required. |
| 2 | Proxy → Listmonk | Sync | HTTP/1.1 | Listmonk is the authoritative source of truth; the response must be returned to the user. |
| 3 | Proxy → Service Bus | **Async** (fire-and-forget) | AMQP 1.0 | Decouples analytics from user latency. A failed publish costs analytics, never a user request. |
| 4 | Service Bus → Function | **Async** (broker-managed pull) | AMQP 1.0 | Function processes at its own rate. Backpressure is naturally handled by queue depth; the Consumption plan auto-scales against it. |
| 5 | Function → Cosmos DB | Sync (within invocation) | HTTPS / REST | The function must confirm the write before acking the Service Bus message; otherwise a crash mid-write followed by redelivery would silently drop data. |
| 6 | Function → WebSocket Gateway | **Async** from the business flow, sync within the call, 3 s timeout | HTTP/1.1 | A failed notify only delays the dashboard; durable state is already in Cosmos DB. The timeout prevents a slow gateway from back-pressuring the function. |
| 7 | Gateway → Client | **Async** push | WebSocket | The server initiates the send; polling would waste bandwidth and add latency. One long-lived connection serves arbitrarily many pushes. |

The pattern is that **synchronous calls are used only when the caller truly needs a response**; all other interactions are asynchronous, insulated by either a message bus or a timeout. This keeps latency low on the user-facing path and lets each tier scale independently.

---

## 4. Consistency Analysis

### 4.1 The CAP Trade-off

The system is best characterised as an **AP** (Availability + Partition-tolerance) system. Under a network partition between the Event Processor and Cosmos DB, or between the Gateway and its clients, the system continues serving requests: the proxy still forwards traffic to Listmonk, events accumulate in Service Bus (retained for up to fourteen days by default), and the Function eventually catches up when the partition heals. The cost is that the dashboard is **eventually consistent** with the true state of the application.

A stricter choice like for example, a two-phase commit between Listmonk and Cosmos DB would turn every user request into a distributed transaction, trading user-facing availability for a guarantee that the analytics view never lags. For an analytics use case this would be inefficient, for a payments ledger it would be essential. The choice is therefore contextual, and we make it explicitly in favour of A and P.

### 4.2 Cosmos DB Consistency Level

We selected **Session consistency** for Cosmos DB. This provides monotonic reads, monotonic writes, read-your-writes, and write-follows-reads within a session context. For the Event Processor, a "session" corresponds to a single Function invocation, which performs a read-modify-write on the `stats` container. Session consistency ensures the function reads its own prior write if the same invocation re-reads the document, which is necessary for the aggregate-counter update pattern. A stricter level (Bounded Staleness or Strong) would provide the same guarantee but at measurably higher write latency and RU cost, and is unnecessary because different function invocations are already serialised per-event through the Service Bus subscription.

### 4.3 Idempotency and At-Least-Once Delivery

Service Bus guarantees **at-least-once** delivery: the Function may see the same event twice (for example, if the function crashes after writing to Cosmos DB but before acking the message). Two idempotency mechanisms are in play:

1. **Raw event storage is idempotent.** The upsert into the `events` container uses `eventId` as the document `id`, so a duplicate write is a no-op.
2. **Aggregate update is *not* fully idempotent in the current implementation.** The read–increment–write pattern against the `stats` container has a race window under duplicate delivery: two concurrent redeliveries of the same event could both read the old counter and both write back `old + 1`, resulting in a net increment of two instead of (correctly) one. We acknowledge this as a known limitation. Two remediations are proposed for future work:

    * **(a) Pre-check the events container.** Read `events/{eventId}`; if it already exists with a `processedAt` field, skip the aggregate update.
    * **(b) Cosmos DB stored procedure.** Wrap steps 1 and 2 in a transactional JavaScript stored procedure whose atomicity is guaranteed within a single partition.

### 4.4 Consistency Window - idk this is mihnea s thing

The *consistency window* — the time between a user action and its reflection on the dashboard — is the sum of: proxy publish latency, Service Bus enqueue-to-deliver time, Function cold-start (if any) or warm-invocation time, Cosmos DB write round-trip, HTTP POST to Gateway, and WebSocket broadcast. We measure this window empirically in Section 5.

> **[FIGURE 3 — placeholder]** Histogram of end-to-end consistency-window measurements across N events under steady 50 RPS load; note the bimodal distribution corresponding to warm vs. cold function invocations.

---

## 5. Performance and Scalability

### 5.1 Load Testing Methodology

We used **Grafana k6** to drive load against the public endpoint of the Listmonk Proxy. The test profile sweeps through four stages — 10, 50, 100, and 500 virtual users — each sustained for five minutes, with a one-minute ramp between stages. Each VU issues `GET /api/subscribers/{randomId}` requests in a tight loop, representing the most common read path on a newsletter manager in production.

We measure:

* **Client-side HTTP latency** (percentiles p50, p95, p99) reported by k6.
* **Azure Function invocations per minute, average execution duration, and maximum concurrent instances** from Application Insights.
* **Service Bus active-message count and incoming/outgoing messages per second** from Azure Monitor.
* **Cosmos DB Request Units (RU) consumed per second** from the Cosmos metrics blade.
* **End-to-end consistency window**, measured by tagging each proxy publish with a timestamp and matching it against the arrival timestamp of the corresponding `stats_updated` message on a dedicated dashboard client, correlated by `eventId`.

> **[FIGURE 4 — placeholder]** k6 test configuration (ramp stages, VU counts, target RPS) and the script used to drive it.

### 5.2 End-to-End Latency - mihnea?

Under a baseline of 50 RPS on the proxy, client-side latency is dominated by the round-trip to Listmonk; analytics instrumentation contributes negligible additional overhead because event publishing is fire-and-forget and runs concurrently with the upstream request.

> **[FIGURE 5 — placeholder]** k6 HTTP latency percentiles (p50 / p95 / p99) across the four load stages.
> **[TABLE 2 — placeholder]** Summary of p50/p95/p99 latencies at each stage, alongside the requests-per-second actually achieved and the error rate.

### 5.3 Azure Function Throughput Under Variable Load

The Consumption plan scales the function horizontally according to the Service Bus queue depth. We observe three distinct regimes:

1. **Sub-saturation (≤ *N* RPS)** — a single function instance keeps up; queue depth stays near zero; end-to-end consistency window is bounded by the function's execution time plus the notify RTT.
2. **Auto-scale regime (*N* to *M* RPS)** — queue depth spikes, the Functions runtime provisions additional instances, and after a brief lag the system reaches a new steady state with queue depth near zero again.
3. **Saturation / cold-start-dominated (> *M* RPS)** — new-instance cold starts become visible as elevated p99 latency on the end-to-end consistency window even though p50 remains stable. This is the expected fingerprint of a Consumption-plan Function under sharp load changes.

> **[FIGURE 6 — placeholder]** Function invocations per minute and active instance count versus offered load.
> **[FIGURE 7 — placeholder]** Service Bus active-message count over time; visible spike-and-drain on each load-stage transition.
> **[FIGURE 8 — placeholder]** Function execution duration percentiles; note the cold-start outliers at p99.

### 5.4 Scaling Behaviour

* **Listmonk Proxy** — scales horizontally on AKS with an HPA on CPU. Stateless; no sticky sessions required.
* **Azure Function** — auto-scales from 0 to 200 instances on the Consumption plan, driven by a queue-length heuristic in the Service Bus scale controller. Scale-out is not instantaneous; cold starts add observable tail latency.
* **Cosmos DB serverless** — scales RU capacity automatically but is capped at 5,000 RU/s per container. Beyond this ceiling the provisioned or autoscale mode becomes necessary; partition-key design (`/resourceType`) ensures writes distribute across physical partitions.
* **WebSocket Gateway** — the hardest tier to scale: a given client's connection terminates at one pod, so scaling out requires either (a) sticky-session load balancing, or (b) a pub/sub fan-out between gateway replicas so that a `/notify` POST to any pod reaches clients attached to every pod. The current implementation scales to a single replica.

---

## 6. Resilience

### 6.1 WebSocket Reconnection - roxana

The client implements **exponential-backoff reconnection** (1 s → 2 s → 4 s → …, capped at 30 s, with jitter to avoid thundering-herd at recovery). On successful reconnect, the server sends `initial_state` from Cosmos DB, so the client is *state-correct* but not *event-complete*: it will not receive push notifications for events that occurred during the outage, only their aggregated effect. For an analytics dashboard this is acceptable; for an audit log it would not be.

### 6.2 Built-in Recovery Mechanisms

* **At-least-once delivery + idempotent storage** — messages survive transient consumer failures without manual intervention.
* **Dead-letter subscription** — permanent "poison" messages are isolated after ten failures so they do not block the subscription.
* **Timeouts on fire-and-forget calls** — prevent a slow dependency from cascading into latency on the critical path.
* **Stateless front tiers** — proxy and gateway pods can be replaced or restarted with no data loss.
* **Declarative infrastructure** — the entire environment is reproducible from Terraform + Helmfile; recovery from catastrophic data-plane loss is bounded by the time to `terraform apply && helmfile sync`.

---

## 7. Comparison with Real-World Systems - can someone actually google this? thx !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

Our architecture is a small-scale instance of patterns that operate at internet scale in production. We contrast with two publicly-documented examples.

### 7.1 Netflix Keystone Pipeline

Netflix's *Keystone* is their unified event-ingestion and routing platform, carrying on the order of a trillion events per day. Producers publish to a Kafka fronting layer; a Keystone router copies events to downstream Kafka clusters and to S3 for batch; stream-processing jobs (originally Samza, later Flink) consume from Kafka and emit to real-time stores and dashboards.

The parallels to our system are strong: Netflix's Kafka corresponds to our Service Bus, their Samza / Flink jobs to our Azure Function, and their real-time analytics stores to our Cosmos DB + dashboard. Both share the core commitment that producers are **decoupled from consumers by a durable message log**, and that real-time consumers are independent of batch consumers.

The differences are telling. Kafka provides a **partitioned, replayable log** where consumers track their own offsets; Service Bus is a **queue / topic model** where the broker tracks delivery and acks. Kafka's model enables re-processing arbitrary historical windows — invaluable when a downstream bug is discovered — whereas Service Bus does not, because messages are removed on successful ack. Netflix's use of stateful stream processors (Flink with RocksDB-backed local state) also allows far richer aggregations than a single-event-in, single-write-out function. For our scale and use case, Service Bus + Azure Functions is an appropriate fit; at Netflix's scale the Kafka model becomes essential.

---

## 8 Use of AI Tools idk mai bagati si voi cv :thumbs_up:

In accordance with the project's transparency requirements, we disclose the following use of generative AI tools during this project:

* **Claude (Anthropic):** used to draft and refine the structure and language of this report.
* **GitHub Copilot:** used to autocomplete boilerplate in the Azure Function handler and suggest Kubernetes manifest patterns.

Every piece of AI-generated content was reviewed, tested, and adapted by the team. All architectural decisions, correctness analyses (notably the idempotency critique in Section 4.3), load-test designs, interpretations of results, and conclusions were authored by the team. AI tools served as accelerators for well-understood tasks — boilerplate code, document phrasing, configuration lookup — and were not treated as authoritative for correctness or design.
