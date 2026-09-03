# ---------------------------------------------------------------------------
# Billing alarm
#
# This project exists because the original AWS account was lost when a free
# trial ran out. An alarm that tells you before that happens again is not
# optional, and it lives in its own file so it cannot be quietly dropped from
# a partial apply of the map resources.
#
# EstimatedCharges is only published to CloudWatch in us-east-1, regardless of
# where the resources actually run -- hence the aliased provider below. This
# catches people out constantly: an alarm created in eu-north-1 against this
# metric simply never fires, because the metric is never there.
# ---------------------------------------------------------------------------

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

resource "aws_sns_topic" "billing_alerts" {
  provider = aws.us_east_1
  name     = "${var.project_name}-billing-alerts"
}

# Skipped entirely when no address is configured, so a non-interactive apply
# still produces the alarm and the topic. Subscribe later by setting
# billing_alert_email and re-applying -- nothing else has to change.
#
# AWS emails a confirmation link that a human has to click. Until that happens
# the subscription sits in "pending confirmation" and delivers nothing, so
# creating this resource is not the same as being protected by it.
resource "aws_sns_topic_subscription" "billing_email" {
  count = var.billing_alert_email != "" ? 1 : 0

  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.billing_alerts.arn
  protocol  = "email"
  endpoint  = var.billing_alert_email
}

resource "aws_cloudwatch_metric_alarm" "estimated_charges" {
  provider = aws.us_east_1

  alarm_name        = "${var.project_name}-estimated-charges"
  alarm_description = "Total estimated AWS charges crossed the configured threshold."

  namespace   = "AWS/Billing"
  metric_name = "EstimatedCharges"
  dimensions  = { Currency = "USD" }

  # Billing metrics update roughly every 6 hours, so a shorter period would
  # spend most of its time in INSUFFICIENT_DATA rather than OK.
  statistic           = "Maximum"
  period              = 21600
  evaluation_periods  = 1
  threshold           = var.billing_alert_threshold_usd
  comparison_operator = "GreaterThanThreshold"

  # Charges reset to zero at the start of each month, which reads as missing
  # data rather than as "fine". Treating it as OK stops a spurious alarm on
  # the first of the month.
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.billing_alerts.arn]
  ok_actions    = [aws_sns_topic.billing_alerts.arn]
}
