# Social authentication and business verification: phase 1

Publishing the code does not apply a database migration or activate social sign-in. No production secrets are included in this repository.

## What is implemented

- Google OIDC with PKCE, nonce, state, signature validation and a browser-bound, single-use callback.
- Apple OIDC with nonce, state, signature validation, a signed client secret and a HTTPS form-post callback.
- Existing password authentication and session-cookie settings remain in use.
- Provider identities are identified by provider + subject. Matching email addresses are not automatically linked. Existing users must use their current sign-in method until explicit authenticated account linking is implemented.
- Social users create an inactive first merchant workspace. No live API key is issued. Apple private-relay email addresses are accepted; workspace email is initially the identity email.
- Console API-key creation rejects inactive merchants. Existing active merchant key creation and the internal paid-activation flow remain unchanged. This is an approval boundary, not full KYB enforcement.
- Session-authenticated payment creation rejects inactive merchants while read access remains available. Payment execution/routing code and API-key-authenticated payment flows are unchanged; existing inactive credentials are not retroactively revoked by this phase.
- Workspace members can read a business profile. Only an OWNER can save drafts or submit. Submitted profiles cannot be edited unless their status is changed to ACTION_REQUIRED through a future review process.
- Only basic registered-business details are collected. This is not completed KYB/KYC, a company registry lookup, or verification of an authorized representative.

## Configuration required before enabling

Backend environment (never commit values):

```
SOCIAL_AUTH_ENABLED=true
SOCIAL_AUTH_CALLBACK_BASE_URL=https://stackaura.co.za
GOOGLE_CLIENT_ID=<web OAuth client ID>
GOOGLE_CLIENT_SECRET=<secret>
APPLE_CLIENT_ID=<Services ID>
APPLE_TEAM_ID=<team ID>
APPLE_KEY_ID=<Sign in with Apple key ID>
APPLE_PRIVATE_KEY=<PKCS8 PEM; escaped newlines are supported>
```

In production, leave SOCIAL_AUTH_ENABLED unset or false until the checked-in migration has been tested and applied to the intended database and the matching frontend callbacks are deployed. Set it to true only as a separate, explicitly approved activation step. Password authentication is not affected by this switch. Non-production local testing does not require the switch.

Register these exact redirect URLs with the corresponding provider:

- Google: https://stackaura.co.za/api/auth/oauth/google/callback
- Apple: https://stackaura.co.za/api/auth/oauth/apple/callback

Use the same frontend origin in SOCIAL_AUTH_CALLBACK_BASE_URL and in the browser. The URL must be an origin, not a path. Google supports HTTP localhost outside production; Apple requires HTTPS and a Secure SameSite=None binding cookie. Configure Apple web authentication's Services ID, associated App ID, domain and return URL in the developer account.

The frontend uses its existing CHECKOUT_API_URL connection. Providers remain disabled when the backend is unavailable or required settings are incomplete. No fake provider login is offered.

Apply the checked-in migration to an isolated development database first, then test with real provider test accounts. Prisma generation and validation do not apply a migration. Do not use production database credentials for local testing.

## Verification flow and outstanding work

The settings screen links to /dashboard/verification. A draft becomes SUBMITTED, not VERIFIED. Submission does not activate the merchant, issue credentials, change pricing, or bypass licensed payment-provider approval. Existing merchant payment access is unchanged; there is no retroactive KYB enforcement in this phase.

Before collecting identity documents or calling this business verification complete:

1. Select a provider with appropriate South African registry, representative/beneficial-owner verification and screening coverage, and confirm obligations with the relevant provider/compliance adviser.
2. Define privacy notice, collection purpose, retention/deletion policy, processor terms, access restrictions and audit evidence.
3. Add provider-hosted verification/document capture; keep identity documents out of application logs and ordinary merchant profile storage.
4. Implement authenticated, signed, replay-resistant provider webhooks and an auditable review/decision workflow. Only verified decisions may set VERIFIED.
5. Define server-enforced live-access policy separately from account sign-in, with an explicit migration policy for existing merchants and provider approval dependencies.
6. Add safe authenticated account linking, work-contact email collection and operational rate limits before production rollout.

No reviewer endpoint, provider integration, identity-document upload, automated company lookup, live-access approval or production deployment is included in phase 1.

## Protocol references

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Apple web authorization](https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server.)
- [openid-client documentation](https://github.com/panva/openid-client/blob/main/docs/README.md)
