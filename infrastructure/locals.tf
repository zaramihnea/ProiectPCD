locals {
  prefix = "${var.project}-${var.environment}"

  tags = {
    project     = var.project
    environment = var.environment
    managed-by  = "terraform"
  }
}
