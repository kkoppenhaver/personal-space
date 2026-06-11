---
title: Planet visuals Phase 11 — thumbnail lighting / capture quality
type: feat
status: completed
date: 2026-06-11
parent: docs/plans/2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md
---

> **Shipped (2026-06-11).** 11a: RT created with `colorSpace: SRGBColorSpace`
> + `samples: 4` — the missing color space was confirmed as the dark-capture
> bug (legacy path measured at **42% of correct brightness** via the new
> `__GAME.testThumbnail()` parity bench; fixed path matches live within
> framing noise). 11b: dedicated capture camera aims at the hero when above
> the geometric horizon (`Planet.heroWorldPosition()`), roll-levels to
> radial up either way, never moves; verified in-browser — hero-aim dot
> 1.0000 when visible, leveled fallback when over the horizon.

# Planet visuals Phase 11 — thumbnail capture quality + framing

## Overview

Phase 11 of the [planet-visuals workstream](2026-05-23-001-feat-planet-visuals-llm-driven-assets-plan.md).
The captured logbook thumbnail is the player's only keepsake of a planet — the
share artifact. Phase 14 re-prioritized this phase as load-bearing: the
thumbnail should frame the premise's subject, not just whatever the cockpit
happened to be looking at. Two problems observed in prod:

1. **Thumbnails are dark.** Every capture reads as underexposed relative to
   the live view.
2. **Framing is luck.** `snapshotNow()` fires at coverage-claim time with the
   live flight camera — the hero (the premise's subject) is often off-frame,
   the horizon tilted mid-bank.

## Root cause (diagnosed, not speculative)

The master plan listed three candidates for the dark capture. Audit verdict:

- **(1) Render-target color space — CONFIRMED, this is the bug.**
  `ThumbnailCapture._snapshot` renders into a `WebGLRenderTarget` created
  with no `colorSpace`. Since three r152, the linear→sRGB output transform is
  driven by the *render target texture's* color space — the default canvas
  pass gets it from `renderer.outputColorSpace` (sRGB by default), but an RT
  with `NoColorSpace` gets **no conversion**. The readback is linear-light
  bytes, which the 2D canvas + JPEG encode treat as sRGB. Linear-as-sRGB is
  exactly a midtone crush (linear 0.2 displays like sRGB ~0.48 should) —
  i.e. "looks a little dark", worst in midtones, shadows near-black.
- **(2) Atmosphere/fog darkening — NOT a parity bug.** `scene.fog` and the
  lerped `setClearColor` are renderer/scene state shared by both passes; the
  capture sees exactly what the player sees. No action.
- **(3) Cockpit-tuned lighting — DEFER.** Tone mapping is `NoToneMapping` in
  both passes (parity holds). Any capture-time exposure boost would have been
  compensating for bug (1); re-evaluate only if captures still read dark
  after the fix. Do not stack a blind boost on top of the real fix.

One more parity gap found during the audit: the live canvas is created with
`antialias: true` but the RT has no MSAA — thumbnails are jaggier than the
live frame. `samples: 4` on the RT restores parity.

## 11a — capture parity (the fix)

**Deliverables:**
- `ThumbnailCapture._snapshot`: create the RT with
  `colorSpace: THREE.SRGBColorSpace` and `samples: 4`. Everything downstream
  (readback → 2D canvas → JPEG) is already correct once the bytes are sRGB.
- `__GAME.testThumbnail()` debug hook: runs `snapshotNow()` and grabs the
  live canvas via `canvas.toBlob()` (`preserveDrawingBuffer: true` is already
  set), then opens both as object URLs side by side. The live canvas is
  ground truth for color parity — this is the verification bench for the fix
  and any future capture-path change.

**Success criteria:**
- `__GAME.testThumbnail()` side-by-side shows no brightness/color shift
  between capture and live frame (sky gradient, terrain midtones, asset
  colors all match by eye).
- Thumbnail edges no longer visibly aliased vs the live view.

## 11b — framing the premise's subject

The concept spine makes the hero asset the visible embodiment of the planet's
premise. The thumbnail should show it when possible.

**Decision: deterministic subject selection, not LLM hint parsing.** The Tier 2
`thumbnail_framing_hint` field (free text, currently unused by any client
code) stays unused — mapping free prose to camera math is fuzzy and
unverifiable. The hero slot direction is already deterministic and *is* the
premise's subject. Document this in the master plan row at ship time; the
schema field stays for a possible future enum-shot version.

**Deliverables:**
- `Planet` exposes the hero's world position after `applyVisuals` (the hero
  slot is already picked in `_pickHeroSlot`; surface its direction/position
  on the planet instance).
- Capture-time composition in `ThumbnailCapture._snapshot`, using a **cloned
  camera** (never mutate the live camera — also removes the existing
  aspect-mutation juggling):
  - **Subject check:** if the planet has a hero mount and it's on the
    player-facing hemisphere (dot of hero direction vs camera→planet
    direction), aim the cloned camera at the hero mount from the player's
    current position; roll the camera so the planet horizon is level
    (up = local radial up).
  - **Fallback:** no hero, or hero on the far side → keep the live camera's
    view direction, but still level the roll. A leveled so-so shot beats a
    banked one.
  - Camera position is never moved — the keepsake stays an authentic "what I
    saw from the cockpit" shot, just aimed and leveled.
- `snapshotNow({ planet })` grows a planet param so the capture knows its
  subject; the claim path in `main.js` (`captureThumbnailWhenReady`) already
  has the planet in hand.

**Success criteria:**
- On a tier-notable/singular planet claimed with the hero in front of the
  player, the thumbnail contains the hero.
- No thumbnail has a visibly tilted horizon.
- Procedural-fallback planets (no hero) still capture, leveled.
- Phase 5 defer logic (reveal-solid wait + 1.5s ceiling + force-solid)
  untouched and still green.

## Out of scope

- Capture-time lighting/exposure boost (re-evaluate after 11a; expected
  unnecessary).
- Parsing `thumbnail_framing_hint` (see decision above).
- Re-capturing existing dark thumbnails in the logbook backend (old entries
  keep their captures; new claims get the fixed path).
- Moving the capture camera off the player's position (postcard-style
  exterior shots) — conflicts with the "artifact of what I witnessed" voice.

## Effort

~1 day. 11a is two lines plus a debug hook; 11b is camera math + a small
Planet surface-area addition.
