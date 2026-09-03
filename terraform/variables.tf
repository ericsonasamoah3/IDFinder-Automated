variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "eu-north-1"
}

variable "project_name" {
  description = "Short name used to prefix all resource names"
  type        = string
  default     = "idfinder1"
}

variable "environment" {
  description = "Deployment environment name (dev, prod, etc.)"
  type        = string
  default     = "dev"
}

variable "github_repo" {
  description = "GitHub repo in 'owner/name' form, used for OIDC trust and Amplify"
  type        = string
  default     = "ericsonasamoah3/IDFinder-Automated"
}

variable "create_github_oidc_provider" {
  description = "Whether to create the GitHub Actions OIDC provider. AWS accounts can only have one of these total (regardless of repo) -- set to false if you already have one from another project, and set existing_github_oidc_provider_arn instead."
  type        = bool
  default     = true
}

variable "existing_github_oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider, used only when create_github_oidc_provider = false. Find yours with: aws iam list-open-id-connect-providers"
  type        = string
  default     = ""
}

variable "github_branch" {
  description = "Branch Amplify Hosting builds from and GitHub Actions deploys from"
  type        = string
  default     = "master"
}

variable "github_access_token" {
  description = "GitHub personal access token (repo scope) so Amplify Hosting can pull the frontend repo. Set via TF_VAR_github_access_token from a GitHub Actions secret -- never commit this."
  type        = string
  sensitive   = true
}

variable "ocr_docker_image" {
  description = "Docker Hub image for the OCR container"
  type        = string
  default     = "ericsonasamoah/ocr123:latest"
}

variable "ocr_api_key" {
  description = "API key the OCR container uses for its own outbound calls. Set via TF_VAR_ocr_api_key from a GitHub Actions secret -- never commit this."
  type        = string
  sensitive   = true
}

variable "ocr_container_port" {
  description = "Port the OCR container listens on. The ericsonasamoah/ocr123 image runs gunicorn bound to 0.0.0.0:8080 -- this must match, or the ALB health check hits a closed port, returns 502, and ECS replaces the task on a loop."
  type        = number
  default     = 8080
}

variable "local_dev_url" {
  description = "Local dev server URL, added to CORS/Cognito allowed origins alongside the deployed Amplify domain"
  type        = string
  default     = "http://localhost:5173"
}

variable "sms_enabled" {
  description = "Whether the backend Lambda actually sends match-notification SMS via SNS. Defaults to false so you can test the report/match flow before requesting SNS SMS sandbox approval (see GETTING_STARTED.md step 5). Set to true once you're ready to send real texts."
  type        = bool
  default     = false
}

variable "cors_allowed_origins" {
  description = "Origins allowed to call the API Gateway endpoints and OCR/save Lambdas. Defaults to '*' to sidestep a circular dependency between Amplify's generated domain and API Gateway's CORS config on first apply. Tighten this to your real Amplify domain (see `terraform output amplify_default_domain`) once you have it, since none of these endpoints require a browser origin check for security -- it's just good hygiene."
  type        = list(string)
  default     = ["*"]
}

variable "save_job_max_receives" {
  description = "How many times an image-save job is retried before SQS moves it to the dead-letter queue. Low on purpose: these failures are almost always a bad payload or a missing permission, and retrying those 10 times just delays the trip to the DLQ."
  type        = number
  default     = 3
}

variable "geocode_job_max_receives" {
  description = "How many times a geocode job is retried before it lands in the DLQ"
  type        = number
  default     = 3
}

variable "geocode_bias_countries" {
  description = <<-EOT
    Comma-separated ISO 3166-1 alpha-3 codes the geocoder biases results
    toward. Without a bias, a query like "High Street" can resolve to any of
    several hundred countries.
  EOT
  type        = string
  default     = "GBR"
}

variable "billing_alert_email" {
  description = <<-EOT
    Address that receives billing alarm notifications. AWS sends a
    confirmation link that must be clicked before anything is delivered --
    the alarm is not protecting you until you do.

    Defaults to empty so a non-interactive `terraform apply` (GitHub Actions)
    is never blocked by a missing value: a variable with no default and no
    TF_VAR fails the plan outright. Empty still creates the alarm and the
    topic, it just subscribes nobody -- so set it, locally in a .tfvars or in
    CI as the BILLING_ALERT_EMAIL secret. An alarm nobody is subscribed to is
    only half an alarm.
  EOT
  type        = string
  default     = ""
}

variable "billing_alert_threshold_usd" {
  description = "Estimated monthly charges, in USD, above which the billing alarm fires"
  type        = number
  default     = 5
}
