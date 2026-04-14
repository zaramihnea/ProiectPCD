resource "azurerm_servicebus_namespace" "main" {
  name                = "${local.prefix}-bus"
  resource_group_name = data.azurerm_resource_group.main.name
  location            = data.azurerm_resource_group.main.location
  sku                 = var.servicebus_sku

  tags = local.tags
}

resource "azurerm_servicebus_topic" "resource_events" {
  name         = "resource-events"
  namespace_id = azurerm_servicebus_namespace.main.id
}

resource "azurerm_servicebus_subscription" "event_processor" {
  name               = "event-processor"
  topic_id           = azurerm_servicebus_topic.resource_events.id
  max_delivery_count = 10
}
