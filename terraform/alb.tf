resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb-sg"
  description = "Allow inbound HTTP to the OCR container ALB"
  vpc_id      = aws_vpc.main.id

  # Internet-facing on purpose: the OCR-process Lambda isn't in a VPC, so it
  # reaches this ALB over the public internet by DNS name (CONTAINER_URL).
  # The container's own API_KEY (used for its outbound OCR provider calls,
  # per your existing lambda code) is the access control here, not network
  # scoping -- there's no practical way to allow-list Lambda's egress IPs
  # since they're shared and rotate. If you want to lock this down further
  # later, consider putting the Lambda in the VPC and making this ALB
  # internal instead.
  ingress {
    description = "HTTP from anywhere"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-alb-sg"
  }
}

resource "aws_lb" "ocr" {
  name               = "${var.project_name}-ocr-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "ocr" {
  # name_prefix, not name: `port` is ForceNew on a target group, so changing
  # ocr_container_port replaces this resource. With a fixed name the replace
  # deadlocks -- the old group can't be destroyed while the listener and the
  # ECS service still reference it, and a create-first would collide on the
  # duplicate name. name_prefix + create_before_destroy lets Terraform stand
  # the new group up, repoint the listener and service, then tear the old one
  # down. (name_prefix is capped at 6 characters for target groups.)
  name_prefix = "idfocr"
  port        = var.ocr_container_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/ping"
    matcher             = "200" # /ping is the container's real health route; "/" 404s
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "ocr" {
  load_balancer_arn = aws_lb.ocr.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ocr.arn
  }
}
