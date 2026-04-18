variable "subscription_id" {
  type        = string
  description = "Azure subscription ID"
}

variable "resource_group_name" {
  type        = string
  description = "Existing resource group name"
  default     = "ProiectPCD"
}

variable "project" {
  type        = string
  description = "Project name used for resource naming and tags"
  default     = "proiectpcd"
}

variable "environment" {
  type        = string
  description = "Deployment environment"
  default     = "production"
}

variable "aks_node_count" {
  type        = number
  description = "Number of AKS user nodes"
  default     = 2
}

variable "aks_node_size" {
  type        = string
  description = "AKS user node VM size"
  default     = "Standard_B2s_v2"
}

variable "servicebus_sku" {
  type        = string
  description = "Azure Service Bus SKU"
  default     = "Standard"
}

variable "websocket_notify_url" {
  type        = string
  description = "Internal URL of the WebSocket gateway /notify endpoint — set after AKS deploy"
  default     = ""
}
