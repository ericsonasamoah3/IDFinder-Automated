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

  # SPA client-side routing (react-router).
  #
  # This was `source = "/<*>"` with `status = "404-200"`, which served
  # index.html for deep links but kept the 404 STATUS on the response --
  # verified against the live site: GET /report-lost returned 404 with
  # index.html's body. React still rendered, but a 404 on a real page is wrong
  # for crawlers, uptime checks and anything that branches on status.
  #
  # The regex is Amplify's documented SPA form: rewrite anything WITHOUT a file
  # extension, and anything whose extension is not a real asset type, to
  # index.html with a true 200. Listing the extensions matters -- a blanket
  # rewrite would swallow /assets/*.js and hand the browser HTML where it
  # expects JavaScript, which blanks the page entirely.
  custom_rule {
    source = "</^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|woff|woff2|ttf|map|json|webp|avif|pmtiles|geojson)$)([^.]+$)/>"
    target = "/index.html"
    status = "200"
  }

  # null_resource.amplify_cognito_env below overwrites this app's env vars
  # out-of-band via the AWS CLI, adding the VITE_COGNITO_* set that can't be
  # declared here (circular dependency -- see the comment on that resource).
  # Without this, every subsequent apply reverts the app to the 4 vars
  # declared above, the null_resource does NOT re-run because its trigger
  # hash is unchanged, and the deployed frontend silently loses its Cognito
  # config -- sign-in breaks with no error at apply time.
  # access_token is ignored for a different reason, and it is the one that has
  # been failing CI. Terraform stores the token in state and diffs it like any
  # other attribute, so whenever the value CI passes differs from the value the
  # last local apply stored, the plan contains an access_token change. Applying
  # that change is an Amplify UpdateApp carrying the token, and Amplify
  # validates it -- a stale or wrong secret comes back as BadRequestException,
  # which is a hard apply failure. Confirmed in CloudTrail: UpdateApp ->
  # BadRequestException from the GitHubActions role, on a plan that had passed.
  #
  # The token is a bootstrap credential. Amplify needs it once, to establish the
  # repository connection; after that the connection stands on its own (the
  # webhook build for this very commit succeeded). Rotating it, or having CI
  # hold a different one, should not be able to break every deploy.
  #
  # To genuinely rotate it: update the value here AND in the GH_ACCESS_TOKEN
  # secret, then remove this from ignore_changes for one apply.
  lifecycle {
    ignore_changes = [environment_variables, access_token]
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
    # The map reads static files from CloudFront only -- never API Gateway,
    # Lambda or DynamoDB. This is the only endpoint the map page needs.
    VITE_MAP_CDN = "https://${aws_cloudfront_distribution.map.domain_name}"
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
