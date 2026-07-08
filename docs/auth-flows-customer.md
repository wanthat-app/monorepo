# Customer authentication flows - sequence diagram

One diagram covering the four customer-facing auth flows: **registration**, **OTP login**,
**passkey login**, and **per-request token verification**. Verified against
`services/app-auth/src/auth/router.ts`, `services/app-core/src/auth/register.ts`,
`packages/auth/src/tickets.ts`, and `infra/lib/api-stack.ts`.

Domains (prod / dev):

- SPA and passkey RP ID: `https://wanthat.app` / `https://dev.wanthat.app` (CloudFront; also fronts `/p/*` landing)
- App HTTP API (app-auth + app-core routes): `https://<app-api-id>.execute-api.il-central-1.amazonaws.com` - the SPA calls it directly (cookieless, not fronted by CloudFront)
- Cognito control plane (server-side admin calls from app-auth): `https://cognito-idp.il-central-1.amazonaws.com`
- Token verification JWKS: `https://cognito-idp.il-central-1.amazonaws.com/<customer-pool-id>/.well-known/jwks.json`

Key invariants (ADR-0006/0006, ADR-0020):

- **Cognito is the only issuer of session tokens** (RS256 JWTs signed by the customer pool).
  The app never mints session credentials.
- **app-auth** (non-VPC) owns the auth ceremonies: Cognito OTP challenges and app-verified
  WebAuthn assertions (DynamoDB `auth_challenge` + `passkey_credential`). It never touches Aurora.
- **app-core** (in-VPC) owns the Aurora `customer` row. The handoff between the two is a
  seconds-lived, single-purpose **Ed25519-signed ticket** - no shared session store.
- The SPA is **cookieless** (ADR-0007): tokens live in localStorage and travel as a Bearer header.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant SPA as Browser SPA<br/>https://wanthat.app<br/>(dev: https://dev.wanthat.app)
    participant AppAuth as app-auth Lambda (non-VPC)<br/>https://app-api-id.execute-api<br/>.il-central-1.amazonaws.com/auth/*
    participant DDB as DynamoDB<br/>auth_challenge, passkey_credential,<br/>phone_velocity, notification_outbox
    participant Cognito as Cognito customer pool<br/>https://cognito-idp<br/>.il-central-1.amazonaws.com
    participant Sender as Custom sender<br/>WhatsApp / SMS
    participant GW as API Gateway JWT authorizer<br/>same execute-api domain
    participant AppCore as app-core Lambda (in-VPC)<br/>same execute-api domain
    participant Aurora as Aurora PG<br/>customer PII

    rect rgb(245, 245, 245)
        Note over User,Sender: 1. Phone + OTP - shared entry for registration AND OTP login (unified flow)
        User->>SPA: enter phone number
        SPA->>AppAuth: POST /auth/start with phone
        AppAuth->>DDB: velocity / rate checks (phone_velocity)
        AppAuth->>Cognito: AdminGetUser by phone (alias)
        opt phone never seen before
            AppAuth->>Cognito: AdminCreateUser (confirmed, suppressed invite,<br/>random permanent password - user stays passwordless)
        end
        AppAuth->>Cognito: AdminInitiateAuth USER_AUTH,<br/>PREFERRED_CHALLENGE = SMS_OTP
        Cognito->>Sender: custom-SMS-sender trigger (8-digit code)
        Sender-->>User: OTP via WhatsApp (default) or SMS<br/>(channel choice + kill switch, ADR-0019)
        AppAuth->>DDB: store challenge session (auth_challenge, TTL)
        AppAuth-->>SPA: challengeId
        User->>SPA: type the code
        SPA->>AppAuth: POST /auth/verify with challengeId + code
        AppAuth->>DDB: load challenge session
        AppAuth->>Cognito: AdminRespondToAuthChallenge (SMS_OTP, code)
        Note right of Cognito: Cognito judges the code and, on success,<br/>mints RS256-signed access/id/refresh JWTs
        Cognito-->>AppAuth: AuthenticationResult (JWTs)
        Note right of AppAuth: seal sub + phone + tokens into an<br/>Ed25519-signed ticket (seconds-lived, ADR-0006)
        AppAuth-->>SPA: registrationTicket
    end

    rect rgb(245, 245, 245)
        Note over SPA,Aurora: 2. Session resolve - the branch that separates login from registration
        SPA->>AppCore: POST /auth/session with ticket
        Note right of AppCore: verify ticket with the Ed25519 PUBLIC key<br/>(plain env var - no secret in the VPC)
        AppCore->>Aurora: SELECT customer WHERE cognito_sub
        alt customer row exists - OTP LOGIN complete
            AppCore-->>SPA: authenticated + tokens + customer profile
            SPA->>SPA: store tokens (localStorage) then go to /home
        else no row - REGISTRATION required
            AppCore-->>SPA: registration_required
            User->>SPA: first name, last name, email
            SPA->>AppCore: POST /auth/register with ticket + profile
            AppCore->>Aurora: INSERT customer (sub = canonical id, ADR-0020)
            AppCore->>DDB: queue welcome message (notification_outbox)
            AppCore-->>SPA: authenticated + tokens + customer profile
        end
    end

    rect rgb(245, 245, 245)
        Note over User,Cognito: 3. Passkey login - app-verified WebAuthn, Cognito only mints (ADR-0006)
        SPA->>AppAuth: GET /auth/passkey/login/challenge (userless)
        AppAuth->>DDB: put single-use challenge (auth_challenge, TTL)
        AppAuth-->>SPA: challengeId + options<br/>(rpId = wanthat.app, empty allowCredentials)
        SPA->>User: navigator.credentials.get()<br/>(auto modal on focus / autofill chip)
        User-->>SPA: Face ID / Touch ID - authenticator signs the challenge
        SPA->>AppAuth: POST /auth/passkey/login/verify<br/>with challengeId + assertion
        AppAuth->>DDB: consume challenge (atomic single-use)
        AppAuth->>DDB: load passkey_credential by credentialId
        Note right of AppAuth: app-auth verifies the assertion ITSELF<br/>(signature, challenge, origin, rpId) - Cognito never sees it
        AppAuth->>DDB: update sign counter
        AppAuth->>Cognito: AdminSetUserPassword (ephemeral random, server-only)<br/>then AdminInitiateAuth ADMIN_USER_PASSWORD_AUTH
        Cognito-->>AppAuth: AuthenticationResult (JWTs)
        AppAuth-->>SPA: registrationTicket + tokens
        SPA->>AppCore: POST /auth/session with ticket, returns authenticated + profile
        Note right of SPA: the /p/ landing (https://wanthat.app/p/*) skips /auth/session<br/>and uses the riding-along tokens directly (Aurora-free, ADR-0007)
    end

    rect rgb(245, 245, 245)
        Note over SPA,AppCore: 4. Token verification - every subsequent API call
        SPA->>GW: any request to the execute-api domain<br/>Authorization Bearer access-JWT
        Note right of GW: JWT authorizer validates signature/issuer/audience/expiry<br/>against https://cognito-idp.il-central-1.amazonaws.com/<br/>customer-pool-id/.well-known/jwks.json - no Lambda, no database
        alt token valid
            GW->>AppCore: route to handler (claims injected)
        else invalid / expired
            GW-->>SPA: 401 (request never reaches a Lambda)
            SPA->>AppAuth: POST /auth/refresh with refreshToken
            AppAuth->>Cognito: AdminInitiateAuth REFRESH_TOKEN_AUTH
            Cognito-->>AppAuth: fresh access/id JWTs
            AppAuth-->>SPA: tokens (retry original request)
        end
    end
```
