terraform {
  # use_lockfile (S3 native state locking, in the backend block below)
  # requires Terraform >= 1.10 -- this floor isn't arbitrary, it's the
  # actual minimum for the config below to work.
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  # Remote state so GitHub Actions runs share state between runs.
  # Bootstrap this bucket ONCE, manually, before first `terraform init`
  # (see terraform/BOOTSTRAP.md). Then uncomment and fill in below.
  # use_lockfile uses S3's native conditional-write locking (Terraform
  # 1.10+) -- no separate DynamoDB lock table needed.
  #
  backend "s3" {
    bucket       = "local-shop-design-app-tfstate-258506450105"
    key          = "idfinder1/terraform.tfstate"
    region       = "us-east-1" # region the STATE BUCKET lives in -- unrelated to where the app's resources deploy (eu-north-1, set via var.aws_region below)
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.aws_region
}
