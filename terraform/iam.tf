# -------------------------------------------------------------------
# GitHub Actions OIDC
# -------------------------------------------------------------------

# AWS accounts can only have ONE GitHub Actions OIDC provider for:
# https://token.actions.githubusercontent.com
#
# If the provider already exists in the AWS account, set:
#
#   create_github_oidc_provider = false
#
# and provide its ARN through:
#
#   existing_github_oidc_provider_arn
#
# Existing provider ARN:
#
# arn:aws:iam::258506450105:oidc-provider/token.actions.githubusercontent.com

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url = "https://token.actions.githubusercontent.com"

  client_id_list = [
    "sts.amazonaws.com"
  ]

  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1"
  ]
}

locals {
  github_oidc_provider_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_github_oidc_provider_arn
}

# -------------------------------------------------------------------
# GitHub Actions OIDC trust policy
# -------------------------------------------------------------------

data "aws_iam_policy_document" "github_oidc_assume" {
  statement {
    effect = "Allow"

    actions = [
      "sts:AssumeRoleWithWebIdentity"
    ]

    principals {
      type = "Federated"

      identifiers = [
        local.github_oidc_provider_arn
      ]
    }

    # GitHub Actions audience.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"

      values = [
        "sts.amazonaws.com"
      ]
    }

    # DO NOT "simplify" this to the stock GitHub format:
    #
    #   repo:${var.github_repo}:ref:refs/heads/${var.github_branch}
    #
    # That is the DEFAULT subject shape, but this repository has a CUSTOMISED
    # OIDC subject claim template configured on the GitHub side, which splices
    # the repository-owner ID and repository ID into the subject with "@".
    #
    # This was tested the hard way on 2026-08-28: swapping the value below for
    # the stock format broke "Configure AWS credentials (OIDC)" immediately --
    # the run that applied the change authenticated with the old value, and
    # every run after it failed. Reverted.
    #
    # If you ever change the repo's OIDC subject template, read the real claim
    # off the "Debug GitHub OIDC claims" step and paste it here verbatim.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"

      values = [
        "repo:ericsonasamoah3@84795350/IDFinder-Automated@1335494099:ref:refs/heads/master"
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name = "${var.project_name}-github-deploy"

  assume_role_policy = data.aws_iam_policy_document.github_oidc_assume.json
}

# -------------------------------------------------------------------
# GitHub Actions Terraform deployment permissions
# -------------------------------------------------------------------

resource "aws_iam_role_policy" "github_deploy" {
  name = "${var.project_name}-github-deploy-policy"
  role = aws_iam_role.github_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Effect = "Allow"

        Action = [
          # ---------------------------------------------------------
          # EC2 / VPC
          # ---------------------------------------------------------
          "ec2:*",

          # ---------------------------------------------------------
          # ECS / Fargate
          # ---------------------------------------------------------
          "ecs:*",

          # ---------------------------------------------------------
          # Application Load Balancer
          # ---------------------------------------------------------
          "elasticloadbalancing:*",

          # ---------------------------------------------------------
          # DynamoDB
          # ---------------------------------------------------------
          "dynamodb:*",

          # ---------------------------------------------------------
          # Lambda
          # ---------------------------------------------------------
          "lambda:*",

          # ---------------------------------------------------------
          # API Gateway
          # ---------------------------------------------------------
          "apigateway:*",

          # ---------------------------------------------------------
          # Cognito
          # ---------------------------------------------------------
          "cognito-idp:*",

          # ---------------------------------------------------------
          # Amplify
          # ---------------------------------------------------------
          "amplify:*",

          # ---------------------------------------------------------
          # S3
          # ---------------------------------------------------------
          "s3:*",

          # ---------------------------------------------------------
          # SNS
          # ---------------------------------------------------------
          "sns:*",

          # ---------------------------------------------------------
          # SSM Parameter Store
          # ---------------------------------------------------------
          "ssm:*",

          # ---------------------------------------------------------
          # CloudWatch Logs
          # ---------------------------------------------------------
          "logs:*",

          # ---------------------------------------------------------
          # IAM
          # ---------------------------------------------------------

          # Read IAM roles.
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",

          # Create/delete IAM roles.
          "iam:CreateRole",
          "iam:DeleteRole",

          # Update IAM role trust policies.
          "iam:UpdateAssumeRolePolicy",

          # Manage inline IAM policies.
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",

          # Manage managed-policy attachments.
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",

          # Pass roles to AWS services.
          "iam:PassRole",

          # Tag IAM roles.
          "iam:TagRole",

          # ---------------------------------------------------------
          # GitHub OIDC provider
          # ---------------------------------------------------------

          # Terraform must be able to inspect the existing provider.
          "iam:GetOpenIDConnectProvider",

          # Included because Terraform manages this resource when
          # create_github_oidc_provider = true.
          "iam:CreateOpenIDConnectProvider",
          "iam:UpdateOpenIDConnectProvider",
          "iam:DeleteOpenIDConnectProvider",
          "iam:TagOpenIDConnectProvider",
          "iam:UntagOpenIDConnectProvider"
        ]

        Resource = "*"
      }
    ]
  })
}

# -------------------------------------------------------------------
# ECS / Fargate IAM
# -------------------------------------------------------------------

# ECS task execution role.
#
# This role is assumed by the ECS/Fargate agent and allows the task
# to:
# - pull container images
# - write logs to CloudWatch
# - retrieve secrets referenced by the task definition

resource "aws_iam_role" "ecs_execution" {
  name = "${var.project_name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Effect = "Allow"

        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }

        Action = "sts:AssumeRole"
      }
    ]
  })
}

# Standard AWS ECS execution permissions.
resource "aws_iam_role_policy_attachment" "ecs_execution_policy" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allows the ECS execution role to retrieve the OCR API key.
resource "aws_iam_role_policy" "ecs_execution_ssm" {
  name = "${var.project_name}-ecs-execution-ssm"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Effect = "Allow"

        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]

        Resource = aws_ssm_parameter.ocr_api_key.arn
      }
    ]
  })
}

# -------------------------------------------------------------------
# ECS application/task IAM role
# -------------------------------------------------------------------

# This role is assumed by the actual OCR container.

resource "aws_iam_role" "ecs_task" {
  name = "${var.project_name}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Effect = "Allow"

        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }

        Action = "sts:AssumeRole"
      }
    ]
  })
}

# Application permissions for the OCR task.

resource "aws_iam_role_policy" "ecs_task_policy" {
  name = "${var.project_name}-ecs-task-policy"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Effect = "Allow"

        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]

        Resource = aws_ssm_parameter.ocr_api_key.arn
      }
    ]
  })
}
