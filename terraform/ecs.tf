resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"
}

resource "aws_security_group" "ocr_task" {
  name        = "${var.project_name}-ocr-task-sg"
  description = "Allow inbound from the ALB only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "From ALB"
    from_port       = var.ocr_container_port
    to_port         = var.ocr_container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-ocr-task-sg"
  }
}

resource "aws_cloudwatch_log_group" "ocr" {
  name              = "/ecs/${var.project_name}-ocr"
  retention_in_days = 14
}

# API_KEY is stored in SSM, not baked into the task definition in plaintext.
resource "aws_ssm_parameter" "ocr_api_key" {
  name  = "/${var.project_name}/ocr/api_key"
  type  = "SecureString"
  value = var.ocr_api_key
}

resource "aws_ecs_task_definition" "ocr" {
  family                   = "${var.project_name}-ocr"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "ocr"
      image     = var.ocr_docker_image
      essential = true
      portMappings = [
        {
          containerPort = var.ocr_container_port
          protocol      = "tcp"
        }
      ]
      secrets = [
        {
          name      = "API_KEY"
          valueFrom = aws_ssm_parameter.ocr_api_key.arn
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ocr.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ocr"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "ocr" {
  name            = "${var.project_name}-ocr"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.ocr.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ocr_task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.ocr.arn
    container_name    = "ocr"
    container_port    = var.ocr_container_port
  }

  depends_on = [aws_lb_listener.ocr]

  # CI/CD or manual scaling may change these outside Terraform; don't fight it.
  lifecycle {
    ignore_changes = [desired_count]
  }
}
