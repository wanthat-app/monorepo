/**
 * Per-DEVICE passkey marker (localStorage) — pure UX gating, never security (Cognito verifies
 * the ceremony regardless). The remembered phone says "a member signed in here"; this flag says
 * "a passkey ceremony actually WORKED here", so the biometric button and the focus auto-arm
 * only appear on devices where the OS sheet can succeed — a device that never enrolled is not
 * offered a ceremony that structurally cannot pass (reported on-device: dead Touch ID button).
 *
 * Transitions:
 * - SET on a successful enrolment ({@link markDevicePasskey} from `enrollPasskey`) or a
 *   successful passkey login (`loginWithPasskey`).
 * - CLEARED when a login ceremony fails with `NotAllowedError` — the browser's "no usable
 *   credential here" signal (also raised on user dismissal; clearing then is accepted — the
 *   next successful ceremony re-sets it, and OTP always remains).
 *
 * Devices that enrolled BEFORE this flag existed start unflagged: their button reappears after
 * the next successful enrolment or login — a deliberate fail-closed default.
 */
const PASSKEY_DEVICE_KEY = "wanthat.passkeyDevice";

// localStorage guards: private mode / tests must degrade (flag off), never crash.

/** Whether a passkey ceremony has succeeded on this device (and none failed since). */
export function hasDevicePasskey(): boolean {
  try {
    return localStorage.getItem(PASSKEY_DEVICE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Record a successful enrolment or passkey login on this device. */
export function markDevicePasskey(): void {
  try {
    localStorage.setItem(PASSKEY_DEVICE_KEY, "1");
  } catch {
    // storage disabled — the flag simply isn't remembered (button stays hidden).
  }
}

/** Drop the marker after a no-credential ceremony failure. */
export function clearDevicePasskey(): void {
  try {
    localStorage.removeItem(PASSKEY_DEVICE_KEY);
  } catch {
    // ignore
  }
}
