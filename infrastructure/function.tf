resource "azurerm_storage_account" "function" {
  name                     = replace("${local.prefix}func", "-", "")
  resource_group_name      = data.azurerm_resource_group.main.name
  location                 = data.azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"

  tags = local.tags
}

resource "azurerm_service_plan" "function" {
  name                = "${local.prefix}-func-plan"
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "Y1"

  tags = local.tags
}

resource "azurerm_linux_function_app" "event_processor" {
  name                       = "${local.prefix}-event-processor"
  resource_group_name        = data.azurerm_resource_group.main.name
  location                   = data.azurerm_resource_group.main.location
  storage_account_name       = azurerm_storage_account.function.name
  storage_account_access_key = azurerm_storage_account.function.primary_access_key
  service_plan_id            = azurerm_service_plan.function.id

  site_config {
    application_stack {
      node_version = "20"
    }
  }

  app_settings = {
    SERVICEBUS_CONNECTION_STRING = azurerm_servicebus_namespace.main.default_primary_connection_string
    SERVICEBUS_TOPIC             = azurerm_servicebus_topic.resource_events.name
    SERVICEBUS_SUBSCRIPTION      = azurerm_servicebus_subscription.event_processor.name
    COSMOS_ENDPOINT              = azurerm_cosmosdb_account.main.endpoint
    COSMOS_KEY                   = azurerm_cosmosdb_account.main.primary_key
    COSMOS_DATABASE              = azurerm_cosmosdb_sql_database.analytics.name
    COSMOS_CONTAINER             = azurerm_cosmosdb_sql_container.events.name
  }

  tags = local.tags
}
