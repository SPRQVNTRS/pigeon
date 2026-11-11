# Security policy

## Reporting a vulnerability

Report a vulnerability through GitHub private vulnerability reporting. Open the "Security" tab of this repository, then choose "Report a vulnerability". This is the only channel. Do not open a public issue, pull request or discussion for a vulnerability.

Please do not disclose the problem publicly until a fix is released.

## What is in scope

- The Pigeon service in `apps/service`: the API, the admin UI, the admin API, the workers and the webhook and inbound mail handling.
- The SDK in `packages/sdk`.
- The admin CLI in `packages/cli`.

Problems in your own deployment, such as a leaked API key or an open database port, are not vulnerabilities in Pigeon. Problems in AWS itself belong with AWS.

## What to include

- What the problem is and which component it affects.
- The version or commit you tested.
- Steps to reproduce it, or a proof of concept.
- What an attacker can do with it.

## What to expect

Pigeon has one maintainer and no bounty program. Reports get an answer on a best-effort basis. There is no guaranteed response time.

## Security model

The guards that protect a deployment, and the settings that control them, are described in [apps/service/docs/security.md](./apps/service/docs/security.md).
