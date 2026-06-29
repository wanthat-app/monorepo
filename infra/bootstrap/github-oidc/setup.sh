#!/usr/bin/env bash
#
# One-time bootstrap of the GitHub Actions OIDC deploy roles (ADR-0015).
#
# Run by an admin with local AWS credentials — NOT by the CI/CD pipeline: this script
# creates the very roles the pipeline authenticates with (a chicken-and-egg that has to be
# resolved out-of-band, like `cdk bootstrap`). Idempotent — safe to re-run.
#
# The policy documents (trust-*.json, assume-cdk.json) in this directory are the source of
# truth; this script just applies them. To adapt to another account, edit the account id in
# those JSON files and pass AWS_ACCOUNT_ID below.
#
# Usage:
#   ./setup.sh
#
set -euo pipefail

ACCOUNT="${AWS_ACCOUNT_ID:-818913587533}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDER_URL="token.actions.githubusercontent.com"
PROVIDER_ARN="arn:aws:iam::${ACCOUNT}:oidc-provider/${PROVIDER_URL}"
# GitHub's well-known root-CA thumbprint. IAM no longer relies on it for these providers,
# but the API still requires a value.
THUMBPRINT="6938fd4d98bab03faadb97b34396831e3780aea1"

echo "==> Ensuring GitHub OIDC provider exists"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  echo "    present: $PROVIDER_ARN"
else
  aws iam create-open-id-connect-provider \
    --url "https://${PROVIDER_URL}" \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list "$THUMBPRINT" >/dev/null
  echo "    created: $PROVIDER_ARN"
fi

for env in dev prod; do
  role="wanthat-deploy-${env}"
  echo "==> Role ${role}"
  if aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$role" \
      --policy-document "file://${HERE}/trust-${env}.json"
    echo "    trust policy updated"
  else
    aws iam create-role --role-name "$role" \
      --assume-role-policy-document "file://${HERE}/trust-${env}.json" \
      --description "GitHub Actions OIDC deploy role for the ${env} environment (ADR-0015)" >/dev/null
    echo "    created"
  fi
  aws iam put-role-policy --role-name "$role" \
    --policy-name cdk-assume \
    --policy-document "file://${HERE}/assume-cdk.json"
  echo "    inline policy 'cdk-assume' applied -> arn:aws:iam::${ACCOUNT}:role/${role}"
done

echo
echo "Done. Next: wire the role ARNs into the repo's GitHub Environments (see README.md)."
