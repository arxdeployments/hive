###############################################################################
# EC2 instance role
#
# The box gets its AWS access from this role and nothing else — there are no
# long-lived access keys anywhere on the instance, in user-data, or in
# infra/.env. The app is written for exactly this: backend/app/services/storage.py
# falls back to minio's IamAwsProvider (instance-metadata credentials) whenever
# RXHIVE_S3_ACCESS_KEY / RXHIVE_S3_SECRET_KEY are empty, which is the deployed
# path. Credentials are rotated by EC2 automatically and are useless off-box.
#
# The same role is what lets the boot script pull the generated secrets out of
# SSM (see secrets.tf) instead of having them typed onto the instance.
###############################################################################

data "aws_iam_policy_document" "app_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "rxhive-${var.environment}-app"
  description        = "Role for the RX HIVE application instance (S3 attachments + SSM secrets)"
  assume_role_policy = data.aws_iam_policy_document.app_assume_role.json

  tags = {
    Project     = "rxhive"
    Environment = var.environment
    Name        = "rxhive-${var.environment}-app"
  }
}

locals {
  # ARN of the parameter *path* itself (…:parameter/rxhive/<env>), which is what
  # ssm:GetParametersByPath authorizes against. Derived from a parameter we
  # already manage so neither the account id nor the region has to be hardcoded
  # or fetched from an extra data source.
  rxhive_ssm_path_arn = trimsuffix(aws_ssm_parameter.secret_key.arn, "/secret_key")
}

data "aws_iam_policy_document" "app" {
  # Object-level attachment access only. No bucket-level mutation verbs
  # (CreateBucket, PutBucketPolicy, PutBucketAcl…): a compromised app process
  # can touch the objects it already manages, but cannot make the bucket public
  # or delete it.
  statement {
    sid = "AttachmentObjects"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]

    resources = ["${aws_s3_bucket.attachments.arn}/*"]
  }

  # storage.ensure_bucket() issues a HeadBucket on start-up, and HeadBucket is
  # authorized by s3:ListBucket on the bucket ARN (not the object ARN). Without
  # this the API errors out on its first attachment call.
  statement {
    sid       = "AttachmentBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.attachments.arn]
  }

  # Scoped to this environment's prefix only: a prod instance cannot read
  # /rxhive/staging/* and vice versa. Two ARNs are needed because
  # GetParametersByPath authorizes against the path, while GetParameter(s)
  # authorizes against each leaf parameter.
  statement {
    sid = "ReadAppSecrets"

    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]

    resources = [
      local.rxhive_ssm_path_arn,
      "${local.rxhive_ssm_path_arn}/*",
    ]
  }

  # secrets.tf stores SecureStrings without an explicit key_id, so they are
  # encrypted under the AWS-managed alias/aws/ssm CMK and reading them needs
  # kms:Decrypt on that key. The key ARN is deliberately NOT looked up: AWS
  # creates alias/aws/ssm lazily, on first SecureString use, so a
  # `data "aws_kms_alias"` on it is resolved at plan time against a key that
  # does not exist yet and hard-fails the very first plan/apply in a fresh
  # account — the greenfield case this stack is built for.
  #
  # The ViaService condition is the scoping instead of a resource ARN, and it
  # is tight in the way that matters: the role can only exercise Decrypt when
  # SSM in this region is making the call for it, never against an arbitrary
  # key directly. Decrypt only — it cannot write new SecureStrings or
  # re-encrypt anything.
  statement {
    sid       = "DecryptAppSecrets"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "rxhive-${var.environment}-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

# Session Manager. This is what lets the security group keep port 22 closed to
# the world: operators get a shell through the SSM agent instead of SSH, with
# IAM-controlled access and an auditable session log. The agent also needs
# ssm:UpdateInstanceInformation etc., which is why the AWS-managed policy is
# used rather than hand-rolling the list.
resource "aws_iam_role_policy_attachment" "ssm_managed_instance_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "app" {
  name = "rxhive-${var.environment}-app"
  role = aws_iam_role.app.name

  tags = {
    Project     = "rxhive"
    Environment = var.environment
    Name        = "rxhive-${var.environment}-app"
  }
}
