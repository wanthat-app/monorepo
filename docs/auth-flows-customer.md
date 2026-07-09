# Customer authentication flows - sequence diagram

> **Target state (ADR-0006).** This document describes the Cognito-native flow decided in
> [ADR-0006](../adrs/0006-cognito-native-auth-and-pii.md), currently being implemented
> (execution plan: [auth-cognito-native-plan.md](./auth-cognito-native-plan.md)). The
> previous app-owned design (app-auth proxy, Ed25519 tickets, app-verified WebAuthn) is
> preserved under *Alternatives considered* in the ADR.

One diagram covering the four customer-facing auth flows: **registration**, **OTP login**,
**passkey login**, and **per-request token verification**. Authentication needs zero backend
calls - the browser talks to Cognito directly; Aurora appears only at the wallet read.

Domains (prod / dev):

- SPA and passkey RP ID: `https://wanthat.app` / `https://dev.wanthat.app` (CloudFront; also fronts `/p/*` landing)
- Cognito public API (called directly from the browser): `https://cognito-idp.il-central-1.amazonaws.com`
- App HTTP API (app-core wallet routes): `https://<app-api-id>.execute-api.il-central-1.amazonaws.com` - the SPA calls it directly (cookieless, not fronted by CloudFront)
- Token verification JWKS: `https://cognito-idp.il-central-1.amazonaws.com/<customer-pool-id>/.well-known/jwks.json`

Key invariants (ADR-0006, ADR-0019, ADR-0020):

- **Cognito is the only issuer of session tokens** (RS256 JWTs signed by the customer pool).
  The app never mints session credentials (ADR-0006).
- **No app code proxies authentication.** The SPA calls the public `cognito-idp` endpoint
  directly for every ceremony: `SignUp` / `ConfirmSignUp`, `InitiateAuth(USER_AUTH)` +
  `RespondToAuthChallenge`, and native `WEB_AUTHN` (ADR-0006).
- **All customer PII lives in Cognito user attributes** (`phone_number`, `given_name`,
  `family_name`, `email`, `locale`, `custom:otpChannel`). The profile the SPA displays is
  the **ID-token claims**, decoded locally; edits go through `UpdateUserAttributes`
  (ADR-0006).
- **Aurora holds money only** - wallet ledger + hash-chained audit log, keyed directly by
  the Cognito `sub`, the canonical user id (ADR-0020). Nothing on the authentication path
  touches Aurora.
- **Passkeys are Cognito-native** (`StartWebAuthnRegistration` / `WEB_AUTHN` challenge);
  Cognito stores and verifies the credentials. RP ID = the site domain. Login requires a
  **remembered phone** - userless/conditional-UI login is waived (ADR-0006).
- **OTP channel** (WhatsApp default / SMS) is the sticky `custom:otpChannel` preference,
  enforced inside the custom-sender trigger against the runtime-config kill switches
  (ADR-0019).
- The SPA is **cookieless** (ADR-0007): tokens live in localStorage and travel as a Bearer
  header.
- **Abuse control sits at the pool boundary**: WAF web ACL on the user pool + Cognito
  request quotas + the SNS SMS spend cap (ADR-0006) - no app-side velocity table.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant SPA as Browser SPA + our login UI<br/>https://wanthat.app<br/>(dev: https://dev.wanthat.app)
    participant Cognito as Cognito public API<br/>https://cognito-idp<br/>.il-central-1.amazonaws.com
    participant Sender as Custom sender<br/>WhatsApp / SMS
    participant GW as API Gateway JWT authorizer<br/>execute-api domain
    participant AppCore as app-core Lambda (in-VPC)<br/>wallet service
    participant Aurora as Aurora PG<br/>MONEY ONLY (ledger + audit,<br/>keyed by sub)

    rect rgb(245, 245, 245)
        Note over User,Sender: 1. Registration IS SignUp - no backend endpoint, no Aurora write
        User->>SPA: phone + first name + last name + email (our form)
        SPA->>Cognito: SignUp (username = phone,<br/>UserAttributes: given_name, family_name,<br/>email, locale, custom:otpChannel)
        Cognito->>Sender: custom-SMS-sender trigger (confirmation code)
        Sender-->>User: code via WhatsApp (default) or SMS<br/>(sticky preference + kill switches, ADR-0019)
        User->>SPA: type the code
        SPA->>Cognito: ConfirmSignUp, then InitiateAuth
        Note right of Cognito: Post-Confirmation trigger queues the welcome<br/>message (notification_outbox, DynamoDB only)
        Cognito-->>SPA: access + id + refresh JWTs (RS256, pool-signed)
        Note right of SPA: profile = ID-token claims, decoded locally -<br/>no /auth/register, no /auth/session,<br/>no backend call at all
    end

    rect rgb(245, 245, 245)
        Note over User,Sender: 2. OTP login - browser calls Cognito directly
        User->>SPA: enter phone
        SPA->>Cognito: InitiateAuth USER_AUTH,<br/>USERNAME = phone, PREFERRED_CHALLENGE = SMS_OTP
        Note right of Cognito: unknown phone yields the user-not-found signal -<br/>the SPA branches to sign-up (section 1)
        Cognito->>Sender: custom-SMS-sender trigger (SMS_OTP code)
        Sender-->>User: code via WhatsApp / SMS
        User->>SPA: type the code
        SPA->>Cognito: RespondToAuthChallenge (SMS_OTP, code)
        Cognito-->>SPA: JWTs - profile from ID-token claims
        Note right of SPA: Aurora is entirely absent from the auth path -<br/>the cold-resume slow login structurally cannot happen
    end

    rect rgb(245, 245, 245)
        Note over User,Cognito: 3. Passkey login - Cognito-native WEB_AUTHN, remembered phone
        Note right of SPA: the SPA auto-arms the ceremony on focus only when<br/>a remembered phone exists - userless login is waived<br/>(one typed phone on a truly new device)
        SPA->>Cognito: InitiateAuth USER_AUTH,<br/>USERNAME = remembered phone, WEB_AUTHN
        Cognito-->>SPA: credential request options (Cognito challenge)
        SPA->>User: navigator.credentials.get() - Face ID / Touch ID
        User-->>SPA: assertion (authenticator signs Cognito's challenge)
        SPA->>Cognito: RespondToAuthChallenge (CREDENTIAL = assertion)
        Note right of Cognito: Cognito verifies against ITS credential store<br/>(enrolment via StartWebAuthnRegistration,<br/>RP ID = wanthat.app / dev.wanthat.app)
        Cognito-->>SPA: JWTs
    end

    rect rgb(245, 245, 245)
        Note over SPA,Aurora: 4. Token verification - every API call - and the only Aurora touch
        SPA->>GW: GET /wallet - Authorization Bearer access-JWT
        Note right of GW: JWT authorizer validates signature/issuer/audience/expiry<br/>against https://cognito-idp.il-central-1.amazonaws.com/<br/>customer-pool-id/.well-known/jwks.json - no Lambda, no database
        alt token valid
            GW->>AppCore: route to handler (claims injected, sub)
            AppCore->>Aurora: ledger read keyed by sub (ADR-0020) -<br/>first Aurora touch, behind the /home skeleton
        else invalid / expired
            GW-->>SPA: 401 (request never reaches a Lambda)
            SPA->>Cognito: InitiateAuth REFRESH_TOKEN_AUTH (browser direct)
            Cognito-->>SPA: fresh access + id JWTs (retry original request)
        end
        SPA->>Cognito: profile edits: UpdateUserAttributes (access token)<br/>+ VerifyUserAttribute for email changes
        Note right of SPA: ID-token claims are stale until the next refresh -<br/>re-fetch via GetUser after an edit
    end
```
