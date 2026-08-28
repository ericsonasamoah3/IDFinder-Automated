resource "aws_amplify_app" "frontend" {
  name       = "${var.project_name}-frontend"
  repository = "https://github.com/${var.github_repo}"

  # Classic PAT auth for Amplify<->GitHub. Generate a token with `repo` and
  # `admin:repo_hook` scopes, store it as the GH_ACCESS_TOKEN GitHub Actions
  # secret, and it flows in here as TF_VAR_github_access_token. Never commit
  # the token itself.
  access_token = var.github_access_token

  platform = "WEB"

  build_spec = <<-EOT
    version: 1
    applications:
      - appRoot: frontend
        frontend:
          phases:
            preBuild:
              commands:
                - npm ci
            build:
              commands:
                - npm run build
          artifacts:
            baseDirectory: dist
            files:
              - '**/*'
          cache:
            paths:
              - node_modules/**/*
  EOT

  environment_variables = {
    VITE_IDFINDER_API_BASE    = aws_apigatewayv2_stage.default.invoke_url
    VITE_ID_PROCESS           = "${aws_apigatewayv2_stage.default.invoke_url}/process"
    VITE_ID_SAVE              = "${aws_apigatewayv2_stage.default.invoke_url}/save"
    AMPLIFY_MONOREPO_APP_ROOT = "frontend"
    # VITE_COGNITO_* vars are intentionally NOT set here -- see
    # null_resource.amplify_cognito_env below for why.
  }

  custom_rule {
    source = "/<*>"
    target = "/index.html"
    status = "404-200" # SPA client-side routing (react-router)
  }

  # null_resource.amplify_cognito_env below overwrites this app's env vars
  # out-of-band via the AWS CLI, adding the VITE_COGNITO_* set that can't be
  # declared here (circular dependency -- see the comment on that resource).
  # Without this, every subsequent apply reverts the app to the 4 vars
  # declared above, the null_resource does NOT re-run because its trigger
  # hash is unchanged, and the deployed frontend silently loses its Cognito
  # config -- sign-in breaks with no error at apply time.
  lifecycle {
    ignore_changes = [environment_variables]
  }
}

resource "aws_amplify_branch" "master" {
  app_id      = aws_amplify_app.frontend.id
  branch_name = var.github_branch

  enable_auto_build = true

  framework = "React"
  stage     = "PRODUCTION"
}

# Cognito's callback_urls (in cognito.tf) depend on this app's default_domain,
# so this app's own environment_variables can't also depend on Cognito's IDs
# -- that would be a circular dependency Terraform rejects outright. Instead,
# once both exist, this injects the Cognito vars via the AWS CLI and kicks
# off a build so the deployed app actually picks them up. Runs in whatever
# environment applies this Terraform (locally or the GitHub Actions runner),
# both of which have AWS credentials already.
locals {
  amplify_env_vars = {
    VITE_IDFINDER_API_BASE     = aws_apigatewayv2_stage.default.invoke_url
    VITE_ID_PROCESS            = "${aws_apigatewayv2_stage.default.invoke_url}/process"
    VITE_ID_SAVE               = "${aws_apigatewayv2_stage.default.invoke_url}/save"
    AMPLIFY_MONOREPO_APP_ROOT  = "frontend"
    VITE_COGNITO_USER_POOL_ID  = aws_cognito_user_pool.main.id
    VITE_COGNITO_CLIENT_ID     = aws_cognito_user_pool_client.web.id
    VITE_COGNITO_DOMAIN        = "${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
    VITE_COGNITO_REDIRECT_URLS = "${var.local_dev_url},https://${var.github_branch}.${aws_amplify_app.frontend.default_domain}"
  }
}

resource "local_file" "amplify_env" {
  filename = "${path.module}/build/amplify-env.json"
  content  = jsonencode(local.amplify_env_vars)
}

resource "null_resource" "amplify_cognito_env" {
  triggers = {
    env_vars_hash = md5(jsonencode(local.amplify_env_vars))
  }

  # Two separate one-line provisioners instead of a single multi-line
  # script: local-exec runs via /bin/sh on Linux/macOS but PowerShell (or
  # cmd) on Windows, and bash-specific syntax (heredocs, `set -e`, `\`
  # line continuations) breaks there. Plain single-line commands work
  # the same everywhere.
  provisioner "local-exec" {
    command = "aws amplify update-app --app-id ${aws_amplify_app.frontend.id} --environment-variables file://${local_file.amplify_env.filename} --region ${var.aws_region}"
  }

  provisioner "local-exec" {
    command = "aws amplify start-job --app-id ${aws_amplify_app.frontend.id} --branch-name ${var.github_branch} --job-type RELEASE --region ${var.aws_region}"
  }

  depends_on = [
    aws_amplify_branch.master,
    aws_cognito_user_pool_client.web,
    local_file.amplify_env,
  ]
}
