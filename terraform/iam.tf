# AWS accounts can only have ONE GitHub OIDC provider total (the URL is
# always the same regardless of repo), so if you've set one up before for
# a different project, creating a second one here will fail with
# EntityAlreadyExists. Set create_github_oidc_provider = false and
# existing_github_oidc_provider_arn = "<arn>" in that case (find it with:
# aws iam list-open-id-connect-providers).
resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  github_oidc_provider_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.existing_github_oidc_provider_arn
}

data "aws_iam_policy_document" "github_oidc_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${var.project_name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_oidc_assume.json
}

# Broad-ish policy scoped to this project's resource types, needed because
# Terraform manages VPC/ECS/ALB/DynamoDB/Lambda/API Gateway/Cognito/Amplify/
# S3/SNS/SSM/IAM for this stack. Tighter than IAMFullAccess (unlike the
# one-time bootstrap user in the other project's setup) but still fairly
# wide -- consider scoping resource ARNs down further once the stack is
# stable and you're not changing infra shape often.
resource "aws_iam_role_policy" "github_deploy" {
  name = "${var.project_name}-github-deploy-policy"
  role = aws_iam_role.github_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:*",
          "ecs:*",
          "elasticloadbalancing:*",
          "dynamodb:*",
          "lambda:*",
          "apigateway:*",
          "cognito-idp:*",
          "amplify:*",
          "s3:*",
          "sns:*",
          "ssm:*",
          "logs:*",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PassRole",
          "iam:TagRole",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
        ]
        Resource = "*"
      },
    ]
  })
}
