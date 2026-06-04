#!/bin/bash
# T079: runs inside the LocalStack container once it's ready (ready.d hook). Creates the
# SQS FIFO queue + DLQ and the face-images S3 bucket the sync engine expects, mirroring
# the Terraform `serverless` module (nhai-sync-queue.fifo / nhai-sync-dlq.fifo).
set -euo pipefail

awslocal sqs create-queue --queue-name nhai-sync-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true

awslocal sqs create-queue --queue-name nhai-sync-queue.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true

awslocal s3 mb s3://nhai-face-images-local

echo "[localstack-init] ready: nhai-sync-queue.fifo, nhai-sync-dlq.fifo, s3://nhai-face-images-local"
