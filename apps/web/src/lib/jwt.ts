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

/**
 * Read display identity (name + email) from an id token, for the admin user card only. Unverified,
 * like {@link groupsFromIdToken}: it only labels the UI. Falls back through `name` → `given_name`.
 */
export function identityFromIdToken(idToken: string | undefined): {
  name?: string;
  email?: string;
} {
  if (!idToken) return {};
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return {};
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<
      string,
      unknown
    >;
    const name =
      typeof json.name === "string"
        ? json.name
        : typeof json.given_name === "string"
          ? json.given_name
          : undefined;
    const email = typeof json.email === "string" ? json.email : undefined;
    return { name, email };
  } catch {
    return {};
  }
}
