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

# ─── Step 3: Build + push custom images to ACR ──────────────────────────────
echo "==> Building and pushing images"
docker build --platform linux/amd64 \
  -t "${ACR_NAME}.azurecr.io/listmonk-proxy:latest" \
  applications/listmonk-proxy/
docker push "${ACR_NAME}.azurecr.io/listmonk-proxy:latest"

# (websocket-gateway and frontend images will be added here)

# ─── Step 4: Package + push Helm charts to ACR ──────────────────────────────
echo "==> Packaging and pushing Helm charts"
mkdir -p /tmp/helm-charts

LISTMONK_VERSION=$(grep '^version:' "$HELM_DIR/charts/listmonk/Chart.yaml" | awk '{print $2}')
helm package "$HELM_DIR/charts/listmonk" --destination /tmp/helm-charts
helm push "/tmp/helm-charts/listmonk-${LISTMONK_VERSION}.tgz" "oci://${ACR_NAME}.azurecr.io/helm"

# (websocket-gateway and frontend charts will be added here)

# ─── Step 5: Deploy cert-manager ─────────────────────────────────────────────
echo "==> Deploying cert-manager"
cd "$HELM_DIR"
helmfile -e azure -l component=cert-manager sync

# ─── Step 6: Deploy Traefik ──────────────────────────────────────────────────
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

# ─── Step 7: Update DNS A record ─────────────────────────────────────────────
echo "==> Updating DNS wildcard A record: *.${DOMAIN} -> ${LB_IP}"
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

# ─── Step 8: Apply cert-manager ClusterIssuer + Certificate ──────────────────
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

# ─── Step 9: Monitoring ──────────────────────────────────────────────────────
echo "==> Deploying Prometheus stack"
helmfile -e azure -l component=prometheus sync

echo "==> Applying monitoring HTTPRoutes"
kubectl apply -f manifests/monitoring/http-routes.yaml

# ─── Step 10: Read Terraform outputs ─────────────────────────────────────────
echo "==> Reading secrets from Terraform"
cd ../infrastructure
SB_CONN=$(terraform output -raw servicebus_connection_string)
cd ../"$HELM_DIR"

# ─── Step 11: Deploy Listmonk ────────────────────────────────────────────────
echo "==> Deploying Listmonk"
helm upgrade --install listmonk \
  "oci://${ACR_NAME}.azurecr.io/helm/listmonk" \
  --version "$LISTMONK_VERSION" \
  --namespace listmonk \
  --create-namespace \
  --values "environments/azure/values/listmonk/values.yaml" \
  --set "serviceBusConnectionString=${SB_CONN}" \
  --set "adminPassword=admin123" \
  --wait \
  --timeout 600s

echo "==> Applying Listmonk HTTPRoute"
kubectl apply -f manifests/listmonk/http-route.yaml

# ─── Step 12: Deploy Azure Function ──────────────────────────────────────────
echo "==> Deploying Azure Function (event-processor)"
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
echo "  Prometheus : https://prometheus.${DOMAIN}"
echo "  Grafana    : https://grafana.${DOMAIN}"
echo "  Grafana pw : ${GRAFANA_PW}"
echo "=========================================="
