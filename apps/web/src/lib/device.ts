/**
 * Device memory (ADR-0022 Flow B). The phone is the Cognito username; remembering it after a
 * successful sign-in lets a returning device offer "visit -> biometric -> in" with no phone prompt.
 * It is the user's own number on their own device (a "remember me"), kept across sign-out so the
 * next passkey login needs no typing; cleared only by an explicit "use a different number".
 */
const KEY = "wanthat.devicePhone";
export const rememberDevicePhone = (phoneE164: string): void =>
  localStorage.setItem(KEY, phoneE164);
export const rememberedDevicePhone = (): string | null => localStorage.getItem(KEY);
export const forgetDevicePhone = (): void => localStorage.removeItem(KEY);
