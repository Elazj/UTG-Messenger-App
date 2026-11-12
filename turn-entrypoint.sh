#!/bin/sh
set -eu

set -- \
  -n \
  --log-file=stdout \
  --realm="${TURN_REALM:-localhost}" \
  --use-auth-secret \
  --static-auth-secret="${TURN_SECRET:-dev-turn-secret-change-me}" \
  --fingerprint \
  --no-cli \
  --listening-port=3478 \
  --min-port=49160 \
  --max-port=49200

if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
  set -- "$@" "--external-ip=${TURN_EXTERNAL_IP}"
fi

exec turnserver "$@"
