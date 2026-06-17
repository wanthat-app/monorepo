# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Status: greenfield.** This repo (`wanthat-infra`) is empty as of this writing — no
> commits or code yet. It is intended to hold the infrastructure-as-code for an **AWS
> serverless system** using **AWS CDK (TypeScript)**. The sections below describe the
> intended toolchain and conventions; update them with concrete details (stacks, services,
> deploy targets) as real code lands, and remove this banner once the project is scaffolded.

## Stack & tooling

- **IaC:** AWS CDK v2 (`aws-cdk-lib`), authored in **TypeScript**.
- **Cloud:** AWS, serverless-first (Lambda, API Gateway / HTTP API, DynamoDB, EventBridge,
  Step Functions, SQS/SNS, S3 — to be confirmed as the design firms up).
- **Runtime:** Node.js + TypeScript for both CDK app code and Lambda function code.

## Commands

> These are the standard CDK + npm commands the project is expected to use. They become
> live once `package.json` and a CDK app exist — confirm/adjust against the actual scripts
> in `package.json` before relying on them.

```bash
npm install              # install dependencies

npm run build            # tsc compile (CDK app + Lambdas)
npm test                 # run the test suite (Jest by default for CDK)
npm test -- <pattern>    # run a single test file / matching tests

npx cdk synth            # synthesize CloudFormation — fastest correctness check, no AWS creds needed
npx cdk diff             # diff proposed changes against deployed stacks (run before every deploy)
npx cdk deploy <Stack>   # deploy a specific stack; omit name + use --all for everything
npx cdk destroy <Stack>  # tear down a stack
```

- `cdk synth` is the cheapest feedback loop — prefer it to validate changes before deploying.
- **Always `cdk diff` before `cdk deploy`** to review what will change.

## Architecture

_To be documented as the system takes shape._ When adding the first stacks, capture here the
"big picture" that spans multiple files — e.g.:

- **Stack boundaries** — what each CDK stack owns and how they depend on each other.
- **Environment strategy** — how dev/staging/prod are separated (separate accounts? CDK
  context/stages? naming conventions?).
- **Cross-stack references** — how stacks share values (exports, SSM params, direct refs).
- **Lambda layout** — where function source lives vs. infra code, and how bundling works.
- **State/config** — bootstrap setup, where environment-specific config is defined.
