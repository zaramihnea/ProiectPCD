output "acr_login_server" {
  value       = azurerm_container_registry.main.login_server
  description = "ACR login server — use in helm env.yaml as acrLoginServer"
}

output "aks_cluster_name" {
  value       = azurerm_kubernetes_cluster.main.name
  description = "AKS cluster name"
}

output "aks_kube_config" {
  value       = azurerm_kubernetes_cluster.main.kube_config_raw
  sensitive   = true
  description = "AKS kubeconfig"
}

output "servicebus_connection_string" {
  value       = azurerm_servicebus_namespace.main.default_primary_connection_string
  sensitive   = true
  description = "Service Bus connection string — inject into Listmonk via Helm secrets"
}

output "cosmosdb_endpoint" {
  value       = azurerm_cosmosdb_account.main.endpoint
  description = "Cosmos DB endpoint"
}

output "cosmosdb_primary_key" {
  value       = azurerm_cosmosdb_account.main.primary_key
  sensitive   = true
  description = "Cosmos DB primary key"
}

output "function_app_name" {
  value       = azurerm_linux_function_app.event_processor.name
  description = "Azure Function app name"
}
