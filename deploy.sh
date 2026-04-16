#!/usr/bin/env bash
# Full redeploy after terraform apply.
# Run from the repo root: ./deploy.sh
set -euo pipefail

RESOURCE_GROUP="ProiectPCD"
AKS_CLUSTER="proiectpcd-production-aks"
HELM_DIR="helm"

echo "==> Getting AKS credentials"
az aks get-credentials \
  --resource-group "$RESOURCE_GROUP" \
  --name "$AKS_CLUSTER" \
  --overwrite-existing

echo "==> Installing Gateway API CRDs"
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml

echo "==> Deploying Traefik"
cd "$HELM_DIR"
helmfile -e azure -l component=traefik sync

echo "==> Applying Traefik Gateway (HTTP only)"
kubectl apply -f manifests/traefik/gateway.yaml

echo "==> Waiting for Traefik LoadBalancer IP..."
until kubectl get svc -n traefik traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null | grep -q '.'; do
  sleep 5
done
LB_IP=$(kubectl get svc -n traefik traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
DOMAIN="${LB_IP}.nip.io"
echo "    LoadBalancer IP: $LB_IP"
echo "    Domain: $DOMAIN"

echo "==> Updating env.yaml with new domain"
sed -i '' "s|^domain:.*|domain: \"${DOMAIN}\"|" environments/azure/env.yaml

echo "==> Deploying Prometheus stack"
helmfile -e azure -l component=prometheus sync

echo "==> Applying monitoring HTTPRoutes"
DOMAIN="$DOMAIN" envsubst < manifests/monitoring/http-routes.yaml | kubectl apply -f -

echo ""
echo "Done. Services available at:"
echo "  Prometheus : http://prometheus.${DOMAIN}"
echo "  Grafana    : http://grafana.${DOMAIN}"
echo "  Grafana pw : $(kubectl get secret -n monitoring kube-prometheus-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d)"
echo ""
echo "Once app images are pushed to ACR, run:"
echo "  cd helm && helmfile -e azure sync"
echo "  DOMAIN=${DOMAIN} envsubst < manifests/listmonk/http-route.yaml | kubectl apply -f -"
echo "  DOMAIN=${DOMAIN} envsubst < manifests/websocket-gateway/http-route.yaml | kubectl apply -f -"
echo "  DOMAIN=${DOMAIN} envsubst < manifests/frontend/http-route.yaml | kubectl apply -f -"
