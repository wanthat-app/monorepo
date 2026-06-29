# GitHub Actions OIDC deploy roles (bootstrap)

One-time, **out-of-band** account bootstrap for the keyless deploy pipeline (ADR-0015).

These resources can't be created by the CI/CD pipeline itself — they are *what the pipeline
authenticates with_. Like `cdk bootstrap`, an admin applies them once with local credentials. The
JSON policy documents here are the version-controlled source of truth; `setup.sh` applies them
idempotently.

## What it creates

| Resource | Purpose |
|---|---|
| OIDC provider `token.actions.githubusercontent.com` | Lets GitHub Actions exchange a workflow token for AWS creds — **no static keys** in GitHub. |
| Role `wanthat-deploy-dev` | Assumable **only** by Actions runs in the repo's `dev` GitHub Environment. |
| Role `wanthat-deploy-prod` | Assumable **only** by Actions runs in the repo's `prod` GitHub Environment. |

Each role is least-privilege: its inline policy (`assume-cdk.json`) allows `sts:AssumeRole` on
`cdk-*` — the CDK bootstrap roles that carry the real deploy permissions — plus read-only
`cloudformation:ListStacks` for the deploy workflow's drift-reconciliation step (which lists live
`wanthat-<env>-*` stacks directly, outside the assumed cdk roles). The GitHub role holds no broad
AWS powers itself.

The trust scoping lives in `trust-dev.json` / `trust-prod.json` via the
`token.actions.githubusercontent.com:sub = repo:wanthat-app/monorepo:environment:<env>` condition,
so a pull request, a different branch context, or another repo cannot assume these roles.

## Prerequisites

- `cdk bootstrap` already run in `il-central-1` and `us-east-1` (creates the `cdk-*` roles).
- Local AWS credentials with IAM admin (to create the provider + roles).

## Run

```bash
cd infra/bootstrap/github-oidc
./setup.sh
```

## Wire into GitHub (consumer side)

`.github/workflows/deploy.yml` reads `vars.CDK_DEPLOY_ROLE_ARN` per environment. After `setup.sh`:

```bash
# create the environments
gh api -X PUT repos/wanthat-app/monorepo/environments/dev
gh api -X PUT repos/wanthat-app/monorepo/environments/prod

# point each environment at its deploy role
gh variable set CDK_DEPLOY_ROLE_ARN --env dev  --repo wanthat-app/monorepo \
  --body arn:aws:iam::818913587533:role/wanthat-deploy-dev
gh variable set CDK_DEPLOY_ROLE_ARN --env prod --repo wanthat-app/monorepo \
  --body arn:aws:iam::818913587533:role/wanthat-deploy-prod
```

### Prod approval gate — known gap

ADR-0015 calls for prod deploys behind a **manual approval**. The proper mechanism is a GitHub
**Required reviewers** rule on the `prod` environment — but environment protection rules on
**private** repos require a **paid plan** (Team/Enterprise). `wanthat-app` is currently on the free
plan, so this rule can't be set (the API returns HTTP 422).

**Interim gate:** `deploy.yml` only deploys prod via manual `workflow_dispatch` (dev auto-deploys on
`main`; prod never does). So a prod deploy already requires a person to explicitly trigger the
workflow and select `prod` — just without a separate second-person approver.

**To close the gap** once on a paid plan:

```bash
UID=$(gh api /users/<approver> --jq '.id')
gh api -X PUT repos/wanthat-app/monorepo/environments/prod \
  -f "reviewers[][type]=User" -F "reviewers[][id]=$UID"
```

## Verify

```bash
aws iam list-roles --query "Roles[?starts_with(RoleName,'wanthat-deploy')].RoleName" --output text
gh variable list --env dev  --repo wanthat-app/monorepo
gh variable list --env prod --repo wanthat-app/monorepo
```
