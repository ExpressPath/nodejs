#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"

RULE_NAME="${RULE_NAME:-ivucx-helper-http}"
NETWORK="${NETWORK:-default}"
TARGET_TAG="${TARGET_TAG:-ivucx-helper}"
SOURCE_RANGES="${SOURCE_RANGES:-0.0.0.0/0}"
PORTS="${PORTS:-tcp:80}"

gcloud compute firewall-rules create "$RULE_NAME" \
  --project="$PROJECT_ID" \
  --network="$NETWORK" \
  --direction=INGRESS \
  --action=ALLOW \
  --rules="$PORTS" \
  --source-ranges="$SOURCE_RANGES" \
  --target-tags="$TARGET_TAG"
