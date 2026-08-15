resource "aws_dynamodb_table" "records" {
  name         = "${var.project_name}-records"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "record_id"

  attribute {
    name = "record_id"
    type = "S"
  }

  attribute {
    name = "match_key"
    type = "S"
  }

  attribute {
    name = "record_type"
    type = "S"
  }

  # Used by idfinder_backend.py's find_match() to look up a pending record
  # of the opposite type sharing the same id_type + id_number_hint, without
  # scanning the whole table.
  global_secondary_index {
    name            = "match-index"
    hash_key        = "match_key"
    range_key       = "record_type"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name = "${var.project_name}-records"
  }
}
