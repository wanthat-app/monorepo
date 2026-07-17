/**
 * Shared inline icons (Wanthat Design System convention: inline SVG, stroke currentColor,
 * 20×20 in a 24 viewBox). Decorative — the surrounding component carries the accessible name.
 * Geometry lifted verbatim from the design handoff mocks.
 */

function IconSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** Shopping cart — "earn on every order" value prop. */
export function CartIcon() {
  return (
    <IconSvg>
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.6 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
    </IconSvg>
  );
}

/** Share nodes — "earn from links" value prop. */
export function ShareNodesIcon() {
  return (
    <IconSvg>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </IconSvg>
  );
}

/** Padlock — "skip codes next time" passkey reassurance chip. */
export function LockIcon() {
  return (
    <IconSvg>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </IconSvg>
  );
}

/** Shield — security / trust value prop. */
export function ShieldIcon() {
  return (
    <IconSvg>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </IconSvg>
  );
}
