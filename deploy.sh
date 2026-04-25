#!/usr/bin/env bash
# Full redeploy after terraform apply.
# Run from the repo root: ./deploy.sh
set -euo pipefail

RESOURCE_GROUP="ProiectPCD"
AKS_CLUSTER="proiectpcd-production-aks"
ACR_NAME="proiectpcdproductionacr"
FUNCTION_APP="proiectpcd-production-event-processor"
DOMAIN="proiectpcd.online"
HELM_DIR="helm"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
else
  echo "==> No .env found, continuing without secrets"
fi

# ─── Step 1: AKS credentials ────────────────────────────────────────────────
echo "==> Getting AKS credentials"
az aks get-credentials \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AKS_CLUSTER" \
  --overwrite-existing

# ─── Step 2: ACR login ───────────────────────────────────────────────────────
echo "==> Logging in to ACR"
ACR_TOKEN=$(az acr login --name "$ACR_NAME" --expose-token --query accessToken -o tsv)
echo "$ACR_TOKEN" | docker login "${ACR_NAME}.azurecr.io" \
  --username "00000000-0000-0000-0000-000000000000" \
  --password-stdin
helm registry login "${ACR_NAME}.azurecr.io" \
  --username "00000000-0000-0000-0000-000000000000" \
  --password "$ACR_TOKEN"

# ─── Step 3: Build + push images to ACR ─────────────────────────────────────
echo "==> Building listmonk-proxy image"
docker build --platform linux/amd64 \
  -t "${ACR_NAME}.azurecr.io/listmonk-proxy:latest" \
  applications/listmonk-proxy/
docker push "${ACR_NAME}.azurecr.io/listmonk-proxy:latest"

echo "==> Building websocket-gateway image"
docker build --platform linux/amd64 \
  -t "${ACR_NAME}.azurecr.io/websocket-gateway:latest" \
  applications/websocket-gateway/
docker push "${ACR_NAME}.azurecr.io/websocket-gateway:latest"

echo "==> Building frontend image"
docker build --platform linux/amd64 \
  -t "${ACR_NAME}.azurecr.io/frontend:latest" \
  applications/frontend/
docker push "${ACR_NAME}.azurecr.io/frontend:latest"

# ─── Step 4: Deploy cert-manager ─────────────────────────────────────────────
echo "==> Deploying cert-manager"
cd "$HELM_DIR"
helmfile -e azure -l component=cert-manager sync

# ─── Step 5: Deploy Traefik ──────────────────────────────────────────────────
echo "==> Deploying Traefik"
helmfile -e azure -l component=traefik sync

echo "==> Applying Traefik Gateway and HTTP redirect"
kubectl apply -f manifests/traefik/gateway.yaml
kubectl apply -f manifests/traefik/http-redirect.yaml

echo "==> Waiting for Traefik LoadBalancer IP..."
until kubectl get svc -n traefik traefik \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null | grep -q '.'; do
  sleep 5
done
LB_IP=$(kubectl get svc -n traefik traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "    LoadBalancer IP: $LB_IP"

# ─── Step 6: Update DNS A record ─────────────────────────────────────────────
echo "==> Updating DNS A records: *.${DOMAIN} and ${DOMAIN} -> ${LB_IP}"
az network dns record-set a delete \
  --resource-group "$RESOURCE_GROUP" \
  --zone-name "$DOMAIN" \
  --name "*" --yes 2>/dev/null || true
az network dns record-set a add-record \
  --resource-group "$RESOURCE_GROUP" \
  --zone-name "$DOMAIN" \
  --record-set-name "*" \
  --ipv4-address "$LB_IP" \
  --ttl 60
az network dns record-set a delete \
  --resource-group "$RESOURCE_GROUP" \
  --zone-name "$DOMAIN" \
  --name "@" --yes 2>/dev/null || true
az network dns record-set a add-record \
  --resource-group "$RESOURCE_GROUP" \
  --zone-name "$DOMAIN" \
  --record-set-name "@" \
  --ipv4-address "$LB_IP" \
  --ttl 60

# ─── Step 7: Apply cert-manager ClusterIssuer + Certificate ──────────────────
echo "==> Applying ClusterIssuer and wildcard Certificate"
cd ../infrastructure
KUBELET_CLIENT_ID=$(terraform output -raw kubelet_identity_client_id)
cd ../"$HELM_DIR"

KUBELET_CLIENT_ID="$KUBELET_CLIENT_ID" envsubst \
  < manifests/cert-manager/cluster-issuer.yaml | kubectl apply -f -
kubectl apply -f manifests/cert-manager/wildcard-certificate.yaml

echo "==> Waiting for wildcard TLS certificate to be issued (may take 1-2 min)..."
kubectl wait certificate wildcard-proiectpcd-online \
  -n traefik \
  --for=condition=Ready \
  --timeout=300s

# ─── Step 8: Monitoring ──────────────────────────────────────────────────────
echo "==> Deploying Prometheus stack"
helmfile -e azure -l component=prometheus sync

echo "==> Applying monitoring HTTPRoutes"
kubectl apply -f manifests/monitoring/http-routes.yaml

# ─── Step 9: Read Terraform outputs ──────────────────────────────────────────
echo "==> Reading secrets from Terraform"
cd ../infrastructure
SB_CONN=$(terraform output -raw servicebus_connection_string)
COSMOS_ENDPOINT=$(terraform output -raw cosmosdb_endpoint)
COSMOS_KEY=$(terraform output -raw cosmosdb_primary_key)
cd ../"$HELM_DIR"

# ─── Step 10: Deploy Listmonk ────────────────────────────────────────────────
echo "==> Deploying Listmonk"
kubectl create namespace listmonk --dry-run=client -o yaml | kubectl apply -f -
if ! kubectl get secret listmonk-secrets -n listmonk &>/dev/null; then
  DB_PASSWORD="$(openssl rand -base64 16)"
else
  DB_PASSWORD="$(kubectl get secret listmonk-secrets -n listmonk -o jsonpath='{.data.password}' | base64 -d)"
fi
SB_CONN="$SB_CONN" DB_PASSWORD="$DB_PASSWORD" envsubst \
  < manifests/listmonk/secret.yaml | kubectl apply -f -
helmfile -e azure -l component=listmonk sync
kubectl apply -f manifests/listmonk/hpa.yaml
kubectl apply -f manifests/listmonk/http-route.yaml
kubectl apply -f manifests/listmonk/service-monitor.yaml
kubectl apply -f manifests/listmonk/grafana-dashboard.yaml

echo "==> Configuring Listmonk app settings"
DB_PASSWORD_PG="$(kubectl get secret listmonk-secrets -n listmonk -o jsonpath='{.data.password}' | base64 -d)"
kubectl exec -n listmonk listmonk-postgresql-0 -- \
  env PGPASSWORD="$DB_PASSWORD_PG" psql -U listmonk -d listmonk -c \
  "UPDATE settings SET value = '\"https://listmonk.${DOMAIN}\"' WHERE key = 'app.root_url';"

if [[ -n "${GMAIL_APP_PASSWORD:-}" ]]; then
  echo "==> Configuring Listmonk SMTP (Gmail)"
  kubectl exec -n listmonk listmonk-postgresql-0 -- \
    env PGPASSWORD="$DB_PASSWORD_PG" psql -U listmonk -d listmonk -c "
      UPDATE settings SET value = '[{
        \"host\": \"smtp.gmail.com\",
        \"port\": 587,
        \"enabled\": true,
        \"password\": \"${GMAIL_APP_PASSWORD}\",
        \"tls_type\": \"STARTTLS\",
        \"username\": \"${GMAIL_USER}\",
        \"max_conns\": 5,
        \"idle_timeout\": \"15s\",
        \"wait_timeout\": \"5s\",
        \"auth_protocol\": \"login\",
        \"email_headers\": [],
        \"hello_hostname\": \"\",
        \"max_msg_retries\": 2,
        \"tls_skip_verify\": false
      }]' WHERE key = 'smtp';
      UPDATE settings SET value = '\"ProiectPCD <${GMAIL_USER}>\"' WHERE key = 'app.from_email';
    "
else
  echo "==> GMAIL_APP_PASSWORD not set, skipping SMTP configuration"
fi

kubectl rollout restart deployment/listmonk -n listmonk
kubectl rollout status deployment/listmonk -n listmonk --timeout=120s

# ─── Step 11: Deploy WebSocket Gateway ───────────────────────────────────────
echo "==> Deploying WebSocket Gateway"
kubectl create namespace websocket-gateway --dry-run=client -o yaml | kubectl apply -f -
COSMOS_ENDPOINT="$COSMOS_ENDPOINT" COSMOS_KEY="$COSMOS_KEY" envsubst \
  < manifests/websocket-gateway/secret.yaml | kubectl apply -f -
helmfile -e azure -l component=websocket-gateway sync
kubectl apply -f manifests/websocket-gateway/http-route.yaml
kubectl apply -f manifests/websocket-gateway/service-monitor.yaml

# ─── Step 12: Deploy Frontend ────────────────────────────────────────────────
echo "==> Deploying Frontend"
helmfile -e azure -l component=frontend sync
kubectl apply -f manifests/frontend/hpa.yaml
kubectl apply -f manifests/frontend/http-route.yaml

# ─── Step 13: Deploy Azure Function ──────────────────────────────────────────
echo "==> Deploying Azure Function (event-processor)"
az functionapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$FUNCTION_APP" \
  --settings WEBSOCKET_NOTIFY_URL="https://websocket.${DOMAIN}/notify"

cd ../services/event-processor
npm install --omit=dev
zip -r /tmp/event-processor.zip . --exclude "*.git*"
az functionapp deployment source config-zip \
  --resource-group "$RESOURCE_GROUP" \
  --name "$FUNCTION_APP" \
  --src /tmp/event-processor.zip
cd ../../"$HELM_DIR"

# ─── Done ────────────────────────────────────────────────────────────────────
GRAFANA_PW=$(kubectl get secret -n monitoring kube-prometheus-stack-grafana \
  -o jsonpath='{.data.admin-password}' | base64 -d)

echo ""
echo "=========================================="
echo "  Deploy complete!"
echo "=========================================="
echo "  Listmonk   : https://listmonk.${DOMAIN}"
echo "  WS Gateway : https://websocket.${DOMAIN}"
echo "  Prometheus : https://prometheus.${DOMAIN}"
echo "  Grafana    : https://grafana.${DOMAIN}"
echo "  Grafana pw : ${GRAFANA_PW}"
echo "=========================================="
