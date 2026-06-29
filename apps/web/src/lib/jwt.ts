/**
 * Read the Cognito `cognito:groups` claim from an id token (client-side, for UI gating only — the
 * authoritative admin check is enforced server-side by admin-api). No signature verification: a
 * forged token only changes what the UI shows; every admin API call is still gated on the server.
 */
export function groupsFromIdToken(idToken: string): string[] {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return [];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<
      string,
      unknown
    >;
    const groups = json["cognito:groups"];
    if (Array.isArray(groups)) return groups.map(String);
    return typeof groups === "string" ? [groups] : [];
  } catch {
    return [];
  }
}

export function isAdminToken(idToken: string | undefined): boolean {
  return idToken ? groupsFromIdToken(idToken).includes("admin") : false;
}
