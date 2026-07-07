# Design-sync notes (Wanthat)

- The design truth is the handoff package in `design/design_handoff_wanthat_app/` (`.dc.html`
  mocks + README with full token spec). The code DS (`apps/web/src/ui/components.tsx`) was
  recreated from those mocks; Dennis: "The current UI is a simple POC level UI. The UI we are
  designing should be inspired by the ./design folder mock. Functionality is from the source."
  → sync the real source components, but verify their look against the handoff tokens and
  surface divergences; ship the handoff README as guidelines.
- `@wanthat/web` is a Vite app, not a library: no `main`/`module`/`exports`, no lib build.
  Converter runs in synth-entry mode from `src/ui/` (components live in `src/ui/components.tsx`).
- Stylesheet: compiled Tailwind. `buildCmd` runs the Tailwind CLI
  (`src/index.css` → `dist/ds-tailwind.css`) so `cssEntry` has a stable, unhashed path.
  The compiled CSS only contains utilities used somewhere in the app (Tailwind content scan)
  — the conventions header must enumerate the real vocabulary.
- Fonts are Google-hosted via `@import` in `index.css` (Space Grotesk, Hanken Grotesk, Heebo)
  → expect `[FONT_REMOTE]` informational, not a failure.
- Repo install: pnpm workspaces (`pnpm i --frozen-lockfile` at root), Node 24.

## Storybook-shape sync (2026-07-07)
- Shape switched to storybook after the DS redo: stories in `apps/web/src/ui/stories/` are the
  preview source; reference at `.design-sync/sb-reference` (copy of `storybook build` output).
- `[GENERAL]` exportedNames needs a real .d.ts tree: `@wanthat/web` is an app, so `buildCmd` runs
  `tsc --declaration --emitDeclarationOnly --outDir dist/types` and package.json `types` points at
  `dist/types/src/ui/index.d.ts`. Without it every story title drops `[TITLE_UNMAPPED]`.
- `[GENERAL]` vite build wipes `apps/web/dist` — always re-run buildCmd (tailwind CSS + tsc types)
  after `pnpm build` before the converter.
- `[GENERAL]` `.storybook/preview.ts` sets backgrounds default to page (#e9edeb) — sb-side captures
  render on grey; judge the component, not the canvas bg (transparent/soft-green components).

## Re-sync risks (watch-list for the next run)
- The reference storybook (`.design-sync/sb-reference`) is a copy of `storybook build` output —
  rebuild it (buildCmd does) whenever stories or src/ui change, or every grade compares against
  the old design.
- `apps/web/dist` is wiped by `pnpm build` (vite): ds-tailwind.css and dist/types must be
  regenerated (buildCmd) before any converter run, or the build fails `[CSS_PLACEHOLDER]` /
  `[TITLE_UNMAPPED]`.
- No owned previews exist (`.design-sync/previews/` is empty by design — every generated
  story-module preview matched); if one appears later it shadows the generated twin forever.
- Button has 7 stories; the roster was graded at the default 6-story cap except Button
  (captured with --max-stories 8 once). Tail stories of other components are covered by the
  verified-by-upload rule.
- Grades assume Google-hosted fonts load at capture time ([FONT_REMOTE]); offline captures
  would fall back silently on both panels.
- Known render warns: none — the 43/43 render check is clean; [GRID_OVERFLOW] was resolved via
  cardMode overrides in config (column for wide rows; single for Screen 520x760 and Sidebar
  300x620).
- Disabled/loading Button style now follows the mock (soft-green #E7F1EC + accent text) — the
  earlier POC used opacity-50; app screens changed accordingly (approved by Dennis 2026-07-07).
- Skeleton loading states (2026-07-07, PR #100): new `Skeleton`/`SkeletonCircle` primitives +
  `loading` prop on 13 data-bearing components, each with a Loading story. Captures are
  animation-stabilized, so `animate-pulse` grades fine. New cardMode column overrides:
  Skeleton, FeatureRow, InviteCard, ProductCard, SettingsRow.
