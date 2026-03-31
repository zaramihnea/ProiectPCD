# ProiectPCD — Claude Code Context

## What is this project

University assignment for the "Distributed Cloud Applications" (PCD) course, Master's degree in AI/Software Systems Engineering. Full requirements are in `Assignment.pdf` in the project root — read it before doing anything.

**Project chosen: Project 1 — Real-time Analytics Dashboard**

Deadline: 27-30 April (Week 10). Team of 3. Deliverables: GitHub repo + scientific report (PDF, min 2000 words) + live demo (~10 minutes).

---

## Architecture Overview

```
Client Browser
     |
     | HTTP REST
     v
Service A (Listmonk, Go/PostgreSQL) ── publishes event ──→ Azure Service Bus Topic (resource-events)
     |                                                                  |
     | PostgreSQL on AKS via PVC (Azure Disk)                          v
     |                                                       Azure Function (FaaS)
     |                                                                  |
     |                                                       writes aggregated stats to Cosmos DB
     |                                                                  |
     |                                                       notifies WebSocket Gateway
     v
WebSocket Gateway (AKS, custom Node.js or Go service)
     |
     | queries Prometheus HTTP API for system metrics
     | reads Cosmos DB for business analytics
     | pushes everything live via WebSocket
     v
Frontend Dashboard (HTML + vanilla JS)
```

---

## Tech Stack

### Azure Services (cloud-native requirements)
| Service | Purpose | Tier |
|---|---|---|
| AKS | Hosts all long-running services | Standard_B2s nodes |
| Azure Service Bus | Async messaging between Service A and Function | Standard |
| Azure Functions | FaaS event processor, triggered by Service Bus | Consumption |
| Cosmos DB | Analytics store — stateful requirement | Serverless, SQL API |
| Azure Container Registry | Docker image registry | Basic |
| Azure Disk | Backs PostgreSQL PVC on AKS | Standard SSD |

### On-cluster (deployed via Helm/manifests)
| Component | Purpose | Chart |
|---|---|---|
| Listmonk | Base application — Service A | Custom chart (or official if available) |
| WebSocket Gateway | Real-time push service | Custom chart |
| PostgreSQL | Database for Listmonk | bitnami/postgresql |
| Prometheus | Metrics scraping | kube-prometheus-stack |

### Tooling
| Tool | Purpose |
|---|---|
| Terraform | All Azure infrastructure, destroy/apply workflow |
| kubectl + Helm | K8s deployments |
| k6 | Load testing for scientific report |

---

## Assignment Requirements Checklist

1. ✅ Min 3 independent components — Listmonk (AKS), WebSocket Gateway (AKS), Azure Function (FaaS)
2. ✅ Min 3 native cloud services, at least one stateful — Service Bus, Azure Functions, Cosmos DB (stateful)
3. ✅ FaaS component — Azure Functions triggered by Service Bus
4. ✅ Real-time communication — WebSocket Gateway
5. ✅ Performance metrics — Prometheus for system metrics, k6 for load testing, results in report
6. ✅ GitHub repo with README — build, deploy, test instructions required

---

## Azure Account Details

- **Subscription ID:** 2c4486f3-ad8d-49f0-9ec0-e01ec5c4e4c3
- **Resource Group:** ProiectPCD (already exists — never recreate it)
- **Region:** northeurope
- **Account type:** Azure for Students ($85 credits remaining)

---

## Infrastructure Notes

- **Terraform** manages all Azure resources. Workflow: `terraform apply` when working, `terraform destroy` when done for the day to save credits.
- **Never destroy Cosmos DB data** — `prevent_destroy = true` lifecycle rule on Cosmos DB and Azure Disk.
- **`terraform.tfvars` is in `.gitignore`** — contains subscription ID and sensitive values, never commit it.
- AKS uses **pod anti-affinity** on Listmonk and WebSocket Gateway pods to spread across zones.
- AKS node size: **Standard_B2s** (2 vCPU, 4GB RAM) — cheapest viable for K8s system node pool.
- B-series VMs are not supported for AKS system node pools — user node pool must be used for app workloads if B-series is chosen; verify this during setup.

---

## Project Structure (expected)

```
ProiectPCD/
├── CLAUDE.md                  ← this file
├── Assignment.pdf             ← full requirements, read this
├── .gitignore
├── infrastructure/            ← all Terraform files
│   ├── main.tf
│   ├── variables.tf
│   ├── terraform.tfvars       ← gitignored, sensitive
│   ├── locals.tf
│   ├── aks.tf
│   ├── acr.tf
│   ├── servicebus.tf
│   ├── cosmosdb.tf
│   ├── function.tf
│   ├── outputs.tf
│   └── README.md
├── services/
│   ├── listmonk/              ← Service A, extended with Service Bus publish
│   ├── websocket-gateway/     ← real-time push service
│   └── event-processor/       ← Azure Function code
├── helm/                      ← Helm charts for all services
│   ├── listmonk/              ← Helm chart for Listmonk + PostgreSQL
│   ├── websocket-gateway/     ← Helm chart for WebSocket Gateway
│   └── prometheus/            ← kube-prometheus-stack values override
├── load-testing/              ← k6 scripts
└── report/                    ← scientific report (PDF)
```

---

## Scientific Report Requirements (Part B)

The report must cover (min 2000 words):
1. **System architecture** — component diagram (Mermaid), data flows
2. **Communication analysis** — sync vs async justification for each service interaction
3. **Consistency analysis** — eventual consistency model, CAP theorem trade-offs
4. **Performance and scalability** — load test results with graphs (latency, throughput), bottleneck identification
5. **Resilience** — behavior when a component fails, recovery mechanisms
6. **Comparison with real systems** — identify a real system (e.g. Twitter, Netflix) using similar patterns

AI tools usage must be disclosed in the Conclusions section.

---

## Bonus Points Available

- Backpressure mechanism when event volume exceeds processing capacity
- gRPC (instead of or alongside WebSocket) for internal service communication
- Real-time latency graphs on dashboard (p50, p95, p99)

---

## Key Decisions Made

- **AKS over Cloud Run** — more control, HA with anti-affinity, better demo (show kubectl live)
- **Listmonk over Fast Lazy Bee** — PostgreSQL is easier to manage on K8s than MongoDB
- **Cosmos DB** — explicitly satisfies the "stateful native cloud service" requirement
- **Prometheus over Azure Monitor** — single tool scrapes everything (nodes, pods, services), simpler than multiple Azure Monitor APIs
- **WebSocket over gRPC** — simpler to implement, gRPC is bonus only
- **North Europe** — cheapest available European region on Azure for Students

---

## Best Practices to Follow

- All Terraform resources tagged consistently via locals (project, environment, managed-by: terraform)
- Sensitive outputs marked `sensitive = true`
- Least-privilege IAM — AKS gets only AcrPull on ACR, nothing more
- No hardcoded values — everything in variables
- `data` source for existing resource group, never `resource`
- Conventional commits on GitHub
- Each service has its own Dockerfile and can be built/run independently
- Helm charts for K8s deployments, no raw `kubectl apply` with manifests
- All Kubernetes deployments managed via Helm charts
- Each service has its own Helm chart with values.yaml for environment-specific config
- Secrets (Service Bus connection string, Cosmos DB key) injected via Helm values from Terraform outputs, never hardcoded in charts
- Use `helm upgrade --install` for idempotent deploys
