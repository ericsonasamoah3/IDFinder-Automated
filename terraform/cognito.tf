resource "aws_cognito_user_pool" "main" {
  name = "${var.project_name}-users"

  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = false
  }

  username_attributes = ["email"]

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${var.project_name}-app"
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.project_name}-web-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email"]
  allowed_oauth_flows_user_pool_client = true

  supported_identity_providers = ["COGNITO"]

  callback_urls = [
    var.local_dev_url,
    "https://${var.github_branch}.${aws_amplify_app.frontend.default_domain}",
  ]

  logout_urls = [
    var.local_dev_url,
    "https://${var.github_branch}.${aws_amplify_app.frontend.default_domain}",
  ]
}
