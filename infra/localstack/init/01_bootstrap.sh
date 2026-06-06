#!/bin/bash
# LocalStack bootstrap: create the S3 bucket and SQS FIFO queues used by the sync engine.

awslocal s3api create-bucket \
  --bucket nhai-face-images-000000000000 \
  --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1

awslocal sqs create-queue \
  --queue-name nhai-sync-queue.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

awslocal sqs create-queue \
  --queue-name nhai-sync-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "LocalStack resources bootstrapped."
