# Contract tests

These tests run against a real `apps/service` instance and verify that
the SDK's DTOs still match the service's wire format.

They are **gated by the `CONTRACT_TEST_BASE_URL` environment variable**
and skip themselves when it is unset — CI does not need to run them.

## Prerequisites

1. `apps/service` running locally or against a staging deployment.
2. An API key for a test app.

## Run

```bash
export CONTRACT_TEST_BASE_URL=http://localhost:3601
export CONTRACT_TEST_API_KEY=ske_test_xxxxx
# Optional — pre-created and verified domain + audience to exercise read paths
export CONTRACT_TEST_DOMAIN_ID=dom_xxx
export CONTRACT_TEST_AUDIENCE_ID=aud_xxx

pnpm --filter @sprqvntrs/pigeon test:contract
```

If any of the optional IDs are unset, the corresponding tests skip.
