output "state_bucket" {
  description = "Bucket S3 con el estado remoto (versionado)."
  value       = aws_s3_bucket.tfstate.bucket
}

output "lock_table" {
  value = aws_dynamodb_table.tflock.name
}

output "ecr_repository_urls" {
  description = "URL de cada repositorio ECR, indexada por nombre de servicio."
  value       = { for name, repo in aws_ecr_repository.service : name => repo.repository_url }
}

output "deployer_access_key_id" {
  value = aws_iam_access_key.deployer.id
}

output "deployer_secret_access_key" {
  value     = aws_iam_access_key.deployer.secret
  sensitive = true
}
