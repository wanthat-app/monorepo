# Admin (employee) authentication flows - sequence diagram

Staff authentication for the admin console. Verified against
`infra/lib/identity-stack.ts` (employee pool), `apps/web/src/lib/admin-login.ts` (PKCE flow),
`services/admin-console/src/guard.ts` (group re-check), and `infra/lib/admin-stack.ts` (authorizer).

Domains (prod / dev):

- Admin console SPA: `https://wanthat.app/admin` / `https://dev.wanthat.app/admin` (same CloudFront app as customers)
- Managed Login hosted UI + OAuth endpoints: `https://wanthat-prod-admin.auth.il-central-1.amazoncognito.com` / `https://wanthat-dev-admin.auth.il-central-1.amazoncognito.com` (Cognito prefix domain - NOT an application domain)
- Admin HTTP API: `https://<admin-http-api-id>.execute-api.il-central-1.amazonaws.com` - called directly by the SPA (separate API from the customer app API)
- Token verification JWKS: `https://cognito-idp.il-central-1.amazonaws.com/<employee-pool-id>/.well-known/jwks.json`

Key properties (ADR-0006 two-pool, ADR-0002 defence in depth):

- **Separate Cognito pool** (`wanthat-<env>-employees`): email sign-in, provisioned only
  (no self-signup), 12+ char password policy, **mandatory TOTP MFA** (no SMS on the staff
  surface). Every employee is in the `admin` group for the MVP.
- Login runs on the employee pool's **Managed Login hosted UI** with OAuth
  **authorization-code + PKCE** - no client secret; callback at `/admin/callback` on the app domain.
- The console sends the **ID token** as the Bearer on purpose: the JWT authorizer verifies it
  (aud = admin SPA client) and its `email` claim gives audited actions a readable actor.
- Tokens live in **sessionStorage** (cleared on tab close); shorter refresh TTL (7 days) than
  customers. An admin session is structurally separate from a customer session - the admin
  API authorizer trusts only the employee pool.

```mermaid
sequenceDiagram
    autonumber
    actor Admin
    participant SPA as Admin console SPA<br/>https://wanthat.app/admin<br/>(dev: https://dev.wanthat.app/admin)
    participant Hosted as Managed Login hosted UI<br/>https://wanthat-prod-admin.auth<br/>.il-central-1.amazoncognito.com
    participant EmpPool as Cognito employee pool<br/>https://cognito-idp<br/>.il-central-1.amazonaws.com
    participant GW as Admin API Gateway JWT authorizer<br/>https://admin-http-api-id.execute-api<br/>.il-central-1.amazonaws.com
    participant LedgerView as admin-ledger-view Lambda (in-VPC)<br/>Aurora record-reads as ledger_reader
    participant Console as admin-console Lambda (non-VPC)<br/>all actions + Dynamo views
    participant AuditW as audit-writer Lambda (in-VPC)<br/>audit_append only
    participant Aurora as Aurora PG<br/>money ledger + audit log
    participant DDB as DynamoDB<br/>runtime_config, product, recommendation
    participant CustPool as Cognito customer pool<br/>https://cognito-idp<br/>.il-central-1.amazonaws.com

    rect rgb(245, 245, 245)
        Note over Admin,EmpPool: 1. Login - hosted Managed Login on the Cognito domain, code + PKCE
        Admin->>SPA: open https://wanthat.app/admin (no session in sessionStorage)
        Note right of SPA: generate PKCE verifier + random state (CSRF),<br/>stash both + return path in sessionStorage
        SPA->>Hosted: redirect to /oauth2/authorize on the Cognito domain<br/>(client_id, code_challenge S256, state)
        Admin->>Hosted: email + password (on the Cognito domain)
        Hosted->>EmpPool: verify credentials
        Admin->>Hosted: TOTP code (MFA is REQUIRED)
        Hosted->>EmpPool: verify TOTP
        Hosted-->>SPA: 302 back to the app domain<br/>https://wanthat.app/admin/callback?code=...&state=...
        Note right of SPA: verify state matches the stashed value (single-use)
        SPA->>Hosted: POST /oauth2/token on the Cognito domain<br/>(code + PKCE verifier)
        Hosted-->>SPA: access + ID + refresh JWTs (RS256, employee pool)
        Note right of SPA: tokens to sessionStorage (cleared on tab close)<br/> route back to the stashed /admin deep link
    end

    rect rgb(245, 245, 245)
        Note over SPA,CustPool: 2. Console API calls - ID token as Bearer, two authorization layers
        SPA->>GW: GET/POST /admin/* on the admin execute-api domain<br/>Authorization Bearer ID-token
        Note right of GW: JWT authorizer: signature/issuer/audience/expiry against<br/>https://cognito-idp.il-central-1.amazonaws.com/<br/>employee-pool-id/.well-known/jwks.json<br/>(customer tokens rejected - wrong issuer)
        alt money stats / activity / user wallet / health - the four record-read routes
            GW->>LedgerView: route with verified claims
            Note right of LedgerView: requireAdmin re-checks cognito groups contains "admin"<br/>(authorizer cannot gate on groups - defence in depth)
            LedgerView->>Aurora: SELECT wallet stats + audit rows as ledger_reader<br/>(read-only by GRANT)
            LedgerView-->>SPA: response
        else everything else - actions + Dynamo views
            GW->>Console: route with verified claims
            Note right of Console: same requireAdmin re-check
            alt config / claims / ops stats
                Console->>DDB: read views - write runtime_config (sole writer)
            else customer administration
                Console->>CustPool: AdminDisableUser / AdminDeleteUser etc (scoped IAM grant)
            end
            Console->>AuditW: sync invoke - AUDIT OR FAIL<br/>(audit actor = email claim from the ID token)
            AuditW->>Aurora: audit_append (hash-chained)
            Console-->>SPA: response
        end
    end

    rect rgb(245, 245, 245)
        Note over SPA,Hosted: 3. Session lifecycle
        Note right of SPA: ID/access tokens valid 1 h, refresh 7 days,<br/>tab close drops the session (sessionStorage)
        SPA->>Hosted: POST /oauth2/token on the Cognito domain<br/>(grant_type refresh_token)
        Hosted-->>SPA: fresh access + ID JWTs
        SPA->>Hosted: /logout on the Cognito domain (token revocation enabled)
    end
```
