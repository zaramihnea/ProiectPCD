resource "azurerm_dns_zone" "main" {
  name                = "proiectpcd.online"
  resource_group_name = data.azurerm_resource_group.main.name
  tags                = local.tags
}

# Wildcard A record — updated by deploy.sh after Traefik LB IP is known
resource "azurerm_dns_a_record" "wildcard" {
  name                = "*"
  zone_name           = azurerm_dns_zone.main.name
  resource_group_name = data.azurerm_resource_group.main.name
  ttl                 = 60
  records             = ["1.2.3.4"] # placeholder — overwritten by deploy.sh
}

# Allow AKS kubelet identity to manage DNS records (cert-manager DNS-01 challenge)
resource "azurerm_role_assignment" "aks_dns_contributor" {
  principal_id                     = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
  role_definition_name             = "DNS Zone Contributor"
  scope                            = azurerm_dns_zone.main.id
  skip_service_principal_aad_check = true
}
