# ECHO characters

Each character is one flat illustration (head and shoulders, facing forward,
eyes open, mouth closed) turned into animated layers: eyes that follow the
cursor, blinking, lip-sync mouth shapes, a turning head and a breathing body.

## Add a character

1. Make a folder `tools/avatar/characters/<id>/` (lower-case id, e.g. `nova`)
   and put the picture in it as `source.jpg`. Check that its licence allows
   modification and use in an app.
2. Find the face and cut out the background (both run on your Mac with
   Apple's Vision framework; nothing is uploaded). Pass the middle of the
   face to the cutout so only that person is kept, not a car or a clothes
   rack behind them:

   ```bash
   swift tools/avatar/landmarks.swift tools/avatar/characters/<id>/source.jpg tools/avatar/characters/<id>/landmarks.json
   swift tools/avatar/cutout.swift tools/avatar/characters/<id>/source.jpg tools/avatar/characters/<id>/cutout.png <face x> <face y>
   ```

3. Draft `config.json` from the landmarks, then check it:

   ```bash
   python3 tools/avatar/prepare_character.py <id> "Echo"
   python3 tools/avatar/prepare_character.py <id> --check /tmp/check.png
   ```

   The draft frames the character like Echo and places the neck. Vision's
   eye outlines are rough on cartoon eyes, so trace the eyes and mouth from
   magnified crops and write them into `config.json`:
   - `eyes.left` / `eyes.right` — either four points
     (`{"corners": [[x,y],[x,y]], "top": [x,y], "bottom": [x,y]}`), an
     ellipse for round eyeballs (`{"ellipse": [cx, cy, rx, ry]}`), or a
     full polygon. `eyes.irises` — `[x, y, radius]` each.
   - `mouth.corners`, and `mouth.line` — points along the line between the
     lips. Add `"grin": true` when the picture already shows teeth, and
     `"rounding": 0.3`–`0.7` for grins or tilted smiles so "oh"/"oo" stay
     natural.
   - `scale` — the iris spacing divided by 366 (Echo's); every pixel size
     in the builder is multiplied by it.
   If no face is detected (very stylised art), write the whole file by hand
   — `characters/echo-analyst/config.json` is an example.
4. Build the layers:

   ```bash
   python3 tools/avatar/build_avatar.py <id>
   ```

   They land in `src/assets/characters/<id>/`, with `portrait.webp` for the
   settings picker and `layout.json` for the animation.
5. Register it in `src/characters/index.ts`: an entry with `id`, `name`,
   `tagline`, `voice` (`'female'` or `'male'` — the character only ever
   speaks in a voice of that gender), the imported `layout.json`, and a
   `theme` — the colours every
   ECHO surface (HUD, command bar, chat panel, settings) takes on while this
   character is selected.
6. `npm run build`. The character appears in Settings → Appearance.

Every character provides the same blink steps and mouth shapes (see
`BLINK_STEPS` and `VISEMES` in `build_avatar.py`), so the animation code in
`src/content/avatar.tsx` works for all of them unchanged.
