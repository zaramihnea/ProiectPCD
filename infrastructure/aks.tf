resource "azurerm_kubernetes_cluster" "main" {
  name                = "${local.prefix}-aks"
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  dns_prefix          = "${local.prefix}-aks"

  default_node_pool {
    name                = "system"
    node_count          = 1
    vm_size             = "Standard_D2s_v3"
    os_disk_size_gb     = 30
    type                = "VirtualMachineScaleSets"
  }

  oidc_issuer_enabled = true

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin = "azure"
    network_policy = "azure"
  }

  tags = local.tags
}

resource "azurerm_kubernetes_cluster_node_pool" "user" {
  name                  = "user"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.main.id
  vm_size               = var.aks_node_size
  os_disk_size_gb       = 30

  enable_auto_scaling = true
  min_count           = 2
  max_count           = 4
  zones               = ["1", "2"]

  tags = local.tags
}
