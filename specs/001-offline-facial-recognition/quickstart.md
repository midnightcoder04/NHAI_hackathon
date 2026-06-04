# Quickstart: Offline Facial Recognition & Liveness Detection

**Phase 1 output for**: `001-offline-facial-recognition`
**Date**: 2026-05-27

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20 LTS+ | https://nodejs.org |
| pnpm | 9+ | `npm i -g pnpm` |
| Expo CLI | latest | `pnpm add -g expo-cli` |
| EAS CLI | latest | `pnpm add -g eas-cli` |
| AWS CLI | v2 | https://aws.amazon.com/cli |
| Terraform | 1.7+ | https://terraform.io (or AWS CDK) |
| Android Studio / Xcode | latest | For device emulation |

---

## Repository Structure

```
NHAI_hackathon/
├── mobile/          # Expo React Native app
├── infra/           # AWS Lambda sync engine + IaC
└── specs/           # Feature documentation (this folder)
```

---

## Mobile App Setup

```bash
cd mobile

# Install dependencies
pnpm install

# Copy environment config
cp .env.example .env.local
# Edit .env.local — set AWS_API_GATEWAY_URL, AWS_REGION, DEVICE_ID_SEED

# Start Expo dev server
pnpm start

# Run on Android emulator
pnpm android

# Run on iOS simulator (macOS only)
pnpm ios
```

### First-time device setup

The app automatically creates the SQLite database (`nhai.db`) and runs migrations on first launch. No manual DB setup needed on device.

---

## AWS Infrastructure Setup

```bash
cd infra

# Configure AWS credentials
aws configure

# Bootstrap Terraform state
terraform -chdir=terraform init

# Preview infrastructure changes
terraform -chdir=terraform plan

# Deploy (creates SQS queues, Lambda, RDS, S3 bucket, API Gateway)
terraform -chdir=terraform apply

# Note the API Gateway URL output — add it to mobile/.env.local
```

### Environment variables (Lambda)

Set via `terraform.tfvars` or directly in AWS console:

```
DB_HOST=<RDS endpoint>
DB_NAME=nhai
DB_USER=nhai_lambda
DB_PASSWORD=<from Secrets Manager>
S3_BUCKET=nhai-face-images-<account>
WEBHOOK_URL=<optional: external system callback URL>
```

---

## Running the Sync Engine Locally (for development)

```bash
cd infra/lambda/sync-engine

pnpm install

# Run unit tests
pnpm test

# Run integration tests (requires LocalStack)
docker compose up -d localstack
pnpm test:integration
```

LocalStack emulates SQS, S3, and (optionally) RDS locally. See `infra/docker-compose.yml`.

---

## Running Tests

```bash
# Mobile unit + integration tests
cd mobile
pnpm test                  # Jest
pnpm test:coverage         # Jest with coverage report (target: ≥80% line, ≥70% branch)
pnpm test:e2e              # Maestro flows (requires running emulator)

# Lambda unit tests
cd infra/lambda/sync-engine
pnpm test

# Contract tests
cd mobile
pnpm test:contract         # Validates sync payload schema
```

---

## Key Configuration Constants

```typescript
// mobile/src/constants/index.ts
export const FACE_MATCH_THRESHOLD = 0.75;        // cosine similarity threshold for "match"
export const LIVENESS_BLINK_FRAMES = 3;          // frames with closed eyes to confirm blink
export const SYNC_BATCH_MAX_PERSONNEL = 100;
export const SYNC_BATCH_MAX_VERIFICATIONS = 500;
export const SYNC_RETRY_MAX_ATTEMPTS = 3;
export const SYNC_RETRY_BACKOFF_MS = 5_000;      // 5s base, exponential
export const IMAGE_STORAGE_DIR = 'face_images/'; // relative to FileSystem.documentDirectory
```

---

## Typical Development Workflow

1. Write a failing test for the new behaviour (`pnpm test -- --watch`)
2. Implement the minimum production code to make the test pass
3. Refactor; keep all tests green
4. Run `pnpm test:coverage` — ensure thresholds maintained
5. Run the app on emulator; verify the golden path manually

---

## Deployment (Production)

```bash
# Build production APK / IPA via EAS
eas build --platform android --profile production
eas build --platform ios --profile production

# Deploy Lambda update
cd infra/lambda/sync-engine
pnpm build
aws lambda update-function-code \
  --function-name nhai-sync-engine \
  --zip-file fileb://dist/handler.zip
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Camera not available in Expo Go | Use development build (`eas build --profile development`) — Vision Camera requires native modules |
| SQLite migration fails on fresh install | Delete app data and reinstall; schema auto-creates on first open |
| SQS messages stuck in DLQ | Check Lambda CloudWatch logs; common causes: RDS connection timeout, schema mismatch |
| Face matching always returns "no match" | Verify embeddings are stored (not null) in `face_image` table; re-register personnel if embeddings are missing |
| S3 pre-signed URL expired | Pre-signed URLs valid 15 min; retry the image upload flow |

---

## Local AWS (LocalStack)

Exercise the sync engine (SQS + S3) locally with no AWS account, via the LocalStack
service in `infra/docker-compose.yml` (T079).

```bash
# 1. Start LocalStack (edge endpoint http://localhost:4566). The ready.d bootstrap
#    (infra/localstack/init/01-bootstrap.sh) creates the FIFO queue + DLQ + S3 bucket.
docker compose -f infra/docker-compose.yml up -d

# 2. Point AWS tooling / awslocal at it and confirm the resources exist
awslocal sqs list-queues          # → nhai-sync-queue.fifo, nhai-sync-dlq.fifo
awslocal s3 ls                     # → s3://nhai-face-images-local

# 3. Run the Lambda sync engine against LocalStack (override the AWS endpoint)
cd infra/lambda/sync-engine && pnpm build
AWS_ENDPOINT_URL=http://localhost:4566 \
AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  node dist/handler.js   # or invoke via your integration test harness

# 4. Tear down
docker compose -f infra/docker-compose.yml down
```

Notes:
- The mobile `SyncService` can target LocalStack by setting `AWS_API_GATEWAY_URL` to a
  local API Gateway emulator or by stubbing the endpoint in integration tests; for the
  Lambda↔SQS↔S3 path, LocalStack alone is sufficient.
- `PERSISTENCE=0` keeps state ephemeral — every `up` starts clean.
