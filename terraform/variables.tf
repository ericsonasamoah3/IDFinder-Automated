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
  description = "Port the OCR container listens on"
  type        = number
  default     = 8000
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
