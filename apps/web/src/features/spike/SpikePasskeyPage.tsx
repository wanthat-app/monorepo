import {
  browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { useEffect, useRef, useState } from "react";

/**
 * THROWAWAY SPIKE (unlinked route /spike/passkey) — proves ONE thing on a real device: does iOS
 * Safari surface a *discoverable* passkey in the phone-field autofill via WebAuthn conditional UI,
 * on the dev.wanthat.app origin? This is the make-or-break unknown for "Option B" fully-automatic
 * biometric login (own the ceremony, empty allowCredentials, userHandle resolves the user). It is
 * 100% client-side: a random in-browser challenge, no backend, no Cognito, no verification — it does
 * NOT authenticate anyone; it only answers "does the autofill chip appear and complete Face ID?".
 * Delete after we have the answer.
 */

const RP_ID = "dev.wanthat.app";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const randomB64url = (n: number): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

export function SpikePasskeyPage() {
  const [log, setLog] = useState<string[]>([]);
  const [autofillSupported, setAutofillSupported] = useState<boolean | null>(null);
  const [platformAvail, setPlatformAvail] = useState<boolean | null>(null);
  const armed = useRef(false);
  const say = (m: string) =>
    setLog((l) => [...l, `${new Date().toISOString().slice(11, 19)}  ${m}`]);

  // Report capability + arm conditional UI once on load.
  useEffect(() => {
    (async () => {
      const [af, pa] = await Promise.all([
        browserSupportsWebAuthnAutofill().catch(() => false),
        platformAuthenticatorIsAvailable().catch(() => false),
      ]);
      setAutofillSupported(af);
      setPlatformAvail(pa);
      say(`browserSupportsWebAuthnAutofill = ${af}`);
      say(`platformAuthenticatorIsAvailable = ${pa}`);
      if (af && !armed.current) {
        armed.current = true;
        say("arming conditional UI (userless get, empty allowCredentials)…");
        try {
          const assertion = await startAuthentication({
            optionsJSON: {
              challenge: randomB64url(32),
              rpId: RP_ID,
              // EMPTY: the discoverable credential must resolve itself (this is the whole point).
              allowCredentials: [],
              userVerification: "required",
              timeout: 120000,
            },
            useBrowserAutofill: true,
          });
          say(`✅ AUTOFILL LOGIN COMPLETED. credentialId=${assertion.id.slice(0, 12)}…`);
          say(`   userHandle=${assertion.response.userHandle ?? "(none)"}`);
        } catch (e) {
          say(
            `conditional get ended: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
          );
        }
      }
    })();
  }, []);

  const enroll = async () => {
    try {
      say("enrolling a discoverable platform passkey (residentKey=required)…");
      const userId = randomB64url(16);
      const reg = await startRegistration({
        optionsJSON: {
          challenge: randomB64url(32),
          rp: { id: RP_ID, name: "Wanthat spike" },
          user: { id: userId, name: `spike-${userId.slice(0, 6)}`, displayName: "Spike User" },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "required",
            requireResidentKey: true,
            userVerification: "required",
          },
          attestation: "none",
          timeout: 120000,
        },
      });
      say(`✅ ENROLLED discoverable passkey. credentialId=${reg.id.slice(0, 12)}…`);
      say("now reload this page — the passkey should appear in the field's autofill.");
    } catch (e) {
      say(`enroll failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  };

  return (
    <div style={{ maxWidth: 560, margin: "40px auto", padding: 16, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 20 }}>Passkey autofill spike</h1>
      <p style={{ color: "#555", fontSize: 14 }}>
        Throwaway. Step 1: tap Enroll and complete Face ID. Step 2: reload — a passkey should appear
        in the field's autofill; tap it and complete Face ID. If the log shows “AUTOFILL LOGIN
        COMPLETED”, conditional UI works on this device.
      </p>
      <div style={{ fontSize: 13, margin: "8px 0" }}>
        autofill supported: <b>{String(autofillSupported)}</b> · platform authenticator:{" "}
        <b>{String(platformAvail)}</b>
      </div>
      <label htmlFor="spike-user" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
        Username (autofill target)
      </label>
      <input
        id="spike-user"
        name="username"
        autoComplete="username webauthn"
        placeholder="tap here — passkeys should appear"
        style={{ width: "100%", height: 44, padding: "0 12px", fontSize: 16, marginBottom: 12 }}
      />
      <button
        type="button"
        onClick={enroll}
        style={{ height: 44, padding: "0 16px", fontSize: 15, cursor: "pointer" }}
      >
        Enroll a discoverable passkey
      </button>
      <pre
        style={{
          marginTop: 16,
          padding: 12,
          background: "#111",
          color: "#0f0",
          fontSize: 12,
          borderRadius: 8,
          whiteSpace: "pre-wrap",
          minHeight: 120,
        }}
      >
        {log.join("\n") || "(log)"}
      </pre>
    </div>
  );
}
