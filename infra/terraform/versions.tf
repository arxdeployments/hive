# ---------------------------------------------------------------------------
# Provider + state configuration for the RX HIVE production stack.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    # Used by secrets.tf to generate the app secrets that are then stored as
    # SSM SecureStrings. Note that random_* results are kept in PLAINTEXT in
    # Terraform state — another reason the backend below must be enabled and
    # encrypted.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }

  # -------------------------------------------------------------------------
  # REMOTE STATE — enable this before the first `terraform apply` that anyone
  # else will ever have to touch.
  #
  # The state file contains the RDS endpoint, the EIP, resource ids and (if a
  # password is ever generated in Terraform) secrets. If it lives only on one
  # laptop, a lost machine means the stack can no longer be managed, and two
  # people applying at once will silently clobber each other.
  #
  # One-time bootstrap (run once, from a shell, NOT from Terraform — the
  # backend must exist before Terraform can use it):
  #
  #   aws s3api create-bucket --bucket rxhive-tfstate-<unique-suffix> \
  #     --region us-east-1
  #   aws s3api put-bucket-versioning --bucket rxhive-tfstate-<unique-suffix> \
  #     --versioning-configuration Status=Enabled
  #   aws s3api put-bucket-encryption --bucket rxhive-tfstate-<unique-suffix> \
  #     --server-side-encryption-configuration \
  #     '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  #   aws s3api put-public-access-block --bucket rxhive-tfstate-<unique-suffix> \
  #     --public-access-block-configuration \
  #     'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
  #
  # Then uncomment the block below, fill in the bucket name, and run
  # `terraform init -migrate-state`.
  #
  # `use_lockfile` gives S3-native locking (AWS provider >= 5.x + Terraform
  # >= 1.10) so no DynamoDB table is required. On older Terraform, drop it and
  # add `dynamodb_table = "rxhive-tflock"` against a table with a `LockID`
  # string hash key instead.
  # -------------------------------------------------------------------------
  # backend "s3" {
  #   bucket       = "rxhive-tfstate-<unique-suffix>"
  #   key          = "prod/terraform.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.region

  # Applied to every resource that supports tagging, so anything added later
  # (or created implicitly by a module) is still attributable to this project.
  # Individual resources additionally set an explicit Name tag.
  default_tags {
    tags = {
      Project     = "rxhive"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
