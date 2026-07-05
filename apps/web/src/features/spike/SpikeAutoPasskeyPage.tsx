import {
  browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable,
  startAuthentication,
} from "@simplewebauthn/browser";
import { useEffect, useRef, useState } from "react";

/**
 * THROWAWAY SPIKE (unlinked route /spike/passkey-auto) — answers ONE question on the real device:
 * does an AUTO **modal** `navigator.credentials.get()` fired on page load (no user gesture, NOT
 * conditional UI) pop the Face ID sheet by itself? Web platform facts we're testing against:
 *   - iOS 16: one gesture-free get() per page load ("freebie"); conditional UI consumes it → that's
 *     why our shipped autofill needs a field tap. A MODAL get() should instead pop the sheet.
 *   - iOS 17.4+: gesture requirement removed entirely → auto-modal should just work.
 *   - Safari allows only ~one async op before get(), so we call it FIRST, before any capability probe.
 * 100% client-side: random challenge, empty allowCredentials (discoverable → surfaces the passkey you
 * already enrolled on dev.wanthat.app), no backend, no verification. It only shows whether the sheet
 * appears automatically. Delete once we have the answer.
 */

const RP_ID = "dev.wanthat.app";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const randomB64url = (n: number): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

function modalGetOptions() {
  return {
    challenge: randomB64url(32),
    rpId: RP_ID,
    allowCredentials: [] as never[], // discoverable — the passkey resolves itself
    userVerification: "required" as const,
    timeout: 120000,
  };
}

export function SpikeAutoPasskeyPage() {
  const [log, setLog] = useState<string[]>([]);
  const armed = useRef(false);
  const say = (m: string) =>
    setLog((l) => [...l, `${new Date().toISOString().slice(11, 19)}  ${m}`]);

  // AUTO-MODAL ON LOAD — the whole point. Fire the modal get() as the very first async op, before any
  // capability probe (Safari's "one async before get()" rule), and see if the sheet pops on its own.
  useEffect(() => {
    if (armed.current) return;
    armed.current = true;
    say(`UA: ${navigator.userAgent}`);
    void (async () => {
      say("AUTO-MODAL: calling modal get() on load (no gesture, no autofill)…");
      try {
        const assertion = await startAuthentication({ optionsJSON: modalGetOptions() });
        say(`✅ AUTO-MODAL PROMPTED + COMPLETED. credentialId=${assertion.id.slice(0, 12)}…`);
        say(`   userHandle=${assertion.response.userHandle ?? "(none)"}`);
      } catch (e) {
        const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        say(`auto-modal ended: ${err}`);
        say(
          "   (NotAllowedError here = sheet was blocked/cancelled/no-passkey, NOT auto-prompted)",
        );
      }
      // Capability probes AFTER, so they don't eat the pre-get() async budget.
      const [af, pa] = await Promise.all([
        browserSupportsWebAuthnAutofill().catch(() => false),
        platformAuthenticatorIsAvailable().catch(() => false),
      ]);
      say(`autofill supported = ${af} · platform authenticator = ${pa}`);
    })();
  }, []);

  // Manual comparison: a gesture-triggered modal get() (this always has activation, so it should work
  // even on old iOS). Confirms the passkey exists + the sheet works when tapped.
  const manualModal = async () => {
    say("MANUAL modal get() (with your tap gesture)…");
    try {
      const a = await startAuthentication({ optionsJSON: modalGetOptions() });
      say(`✅ manual modal completed. credentialId=${a.id.slice(0, 12)}…`);
    } catch (e) {
      say(`manual modal: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  };

  const reload = () => window.location.reload();

  return (
    <div style={{ maxWidth: 600, margin: "32px auto", padding: 16, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 20 }}>Passkey AUTO-prompt spike</h1>
      <p style={{ color: "#555", fontSize: 14 }}>
        On load this fires a <b>modal</b> passkey get() with no tap. If the Face ID sheet pops by
        itself and the log shows “AUTO-MODAL PROMPTED + COMPLETED”, automatic prompt works on this
        device — and we can wire it into the real auth screen. If it shows NotAllowedError, this
        device blocks gesture-free prompts (older iOS) and one tap is the floor. Reload to re-test
        (each page load gets a fresh attempt).
      </p>
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <button
          type="button"
          onClick={reload}
          style={{ height: 44, padding: "0 16px", fontSize: 15, cursor: "pointer" }}
        >
          Reload &amp; auto-test
        </button>
        <button
          type="button"
          onClick={manualModal}
          style={{ height: 44, padding: "0 16px", fontSize: 15, cursor: "pointer" }}
        >
          Manual modal (with tap)
        </button>
      </div>
      <pre
        style={{
          marginTop: 12,
          padding: 12,
          background: "#111",
          color: "#0f0",
          fontSize: 12,
          borderRadius: 8,
          whiteSpace: "pre-wrap",
          minHeight: 160,
        }}
      >
        {log.join("\n") || "(log)"}
      </pre>
    </div>
  );
}
