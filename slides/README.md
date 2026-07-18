# Slides

`wanthat-presentation.pptx` is **generated** from `presentation.md` — edit the
script, then regenerate the deck. Do not hand-edit the pptx.

## Source of truth

- `presentation.md` — the authoritative script: a global style block, then one
  `## Slide N — Title (timing)` section per slide with a layout hint, on-slide
  content, the visual (an `assets/` image or an inline mermaid source), and
  `Speaker notes:` paragraphs (which land in the pptx notes pane).
- `assets/` — phone snapshots (~2x captures of 340x587 frames) used by the two
  user-flow slides.

## Regeneration process

1. **Extract** every ` ```mermaid ` block from `presentation.md` (slides 7, 8,
   B4, B5, B6, B10, B13, B14) into standalone `.mmd` files.
2. **Render** each block to PNG at ~2x with mermaid-cli (chromium-based; the
   theme config keeps the deck's evergreen palette — pale-green nodes, gray
   clusters — while the classDefs inside each source carry the diagram color
   code: green = our compute, orange = data stores, purple = external/managed,
   gray = clients):

   ```bash
   npx -y @mermaid-js/mermaid-cli -i slide-7.mmd -o slide-7.png \
     -w 2200 -b transparent -c theme.json
   ```

3. **Build** the deck with python-pptx (venv with `python-pptx` + `pillow`):
   16:9, one slide per script section in order (11 main + a dark Backup divider
   + 16 backup), speaker notes parsed straight out of the script. Layout mirrors
   the deck conventions: dark `#15201C` title/divider slides, light `#F4F6F5`
   content slides, Space Grotesk / Hanken Grotesk / Space Mono, evergreen
   `#1F7A57` accent, white cards with `#E6EBE8` borders, kicker + big slide
   number header, wanthat-wordmark footer. Phone snapshots render in
   equal-width rows with URL chips above and numbered captions below; tables
   use a dark header row with `#7FE0B0` labels. PNGs over 300KB are compressed
   with pillow.
4. **Verify** by reopening the pptx: slide count matches the script's sections,
   every visual slide has its picture shape, notes present where the script
   provides them, and no shape falls outside the 13.33x7.5in canvas.

Facts in the script are verified against `docs/AWS_Architecture.md` and
`adrs/`; mermaid sources are ASCII-only with no semicolons (renderer
constraint).
