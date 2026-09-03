output "api_base_url" {
  value = aws_apigatewayv2_stage.default.invoke_url
}

output "process_url" {
  value = "${aws_apigatewayv2_stage.default.invoke_url}/process"
}

output "save_url" {
  value = "${aws_apigatewayv2_stage.default.invoke_url}/save"
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "cognito_domain" {
  value = "${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "amplify_app_id" {
  value = aws_amplify_app.frontend.id
}

output "amplify_default_domain" {
  value = "https://${var.github_branch}.${aws_amplify_app.frontend.default_domain}"
}

output "ocr_container_url" {
  value = "http://${aws_lb.ocr.dns_name}/"
}

output "github_deploy_role_arn" {
  description = "Put this in the GitHub Actions workflow's role-to-assume"
  value       = aws_iam_role.github_deploy.arn
}

output "dynamodb_table_name" {
  value = aws_dynamodb_table.records.name
}

output "uploads_bucket_name" {
  value = aws_s3_bucket.uploads.bucket
}

output "save_jobs_queue_url" {
  value = aws_sqs_queue.save_jobs.id
}

output "save_dlq_url" {
  description = "Failed image-save jobs land here. Inspect with: aws sqs receive-message --queue-url <this>"
  value       = aws_sqs_queue.save_dlq.id
}

output "map_cdn_url" {
  description = "Set as VITE_MAP_CDN. The map page reads basemap.pmtiles and pins/*.geojson from here."
  value       = "https://${aws_cloudfront_distribution.map.domain_name}"
}

output "map_bucket_name" {
  description = "Upload the basemap here once, by hand: aws s3 cp basemap.pmtiles s3://<this>/basemap.pmtiles"
  value       = aws_s3_bucket.map.bucket
}

output "geocache_table_name" {
  value = aws_dynamodb_table.geocache.name
}

output "geocode_jobs_queue_url" {
  value = aws_sqs_queue.geocode_jobs.id
}

output "geocode_dlq_url" {
  description = "Failed geocode jobs land here. Inspect with: aws sqs receive-message --queue-url <this>"
  value       = aws_sqs_queue.geocode_dlq.id
}
