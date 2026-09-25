"""
Derives every NikahMate brand asset from the supplied source artwork.

The source is a single raster lockup: the heart-and-crescent symbol above the
NikahMate wordmark, on a dark emerald panel. That one image cannot be used
directly for all the slots a mobile app needs, so this script separates it into
its parts and rebuilds each asset properly:

  * The symbol and the wordmark are cut out of the source onto transparency.
    The source panel and the field behind it are nearly the same colour, so the
    cutout keys on distance from a per-row background estimate sampled from a
    clean left margin rather than on luminance alone.

  * The app icon is then recomposited onto a ground this script controls. The
    source has rounded corners and a drop shadow baked in; iOS and Android
    apply their own mask, and a pre-rounded icon inside that mask produces
    double corners and a shadow fringe. Rebuilding on a full-bleed ground
    avoids both.

  * The Android adaptive foreground and the splash use the symbol ALONE. The
    launcher crops the foreground to a circle or squircle, and a wordmark does
    not survive that. It would not be legible at launcher size in any case.

Run after changing the source artwork:

    python apps/mobile/scripts/build-brand-assets.py

Requires Pillow (a developer tool only — it is not an app dependency).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
APP_ASSETS = HERE.parent / "assets"
BRAND = HERE.parent.parent.parent / "docs" / "brand"
SOURCE = BRAND / "source" / "nikahmate-logo-source.webp"

# Brand ground. Matches palette.ts: emerald 900 -> 700, a two-stop diagonal.
GROUND_FROM = (3, 41, 31)
GROUND_TO = (6, 95, 70)

# Regions of the source, found by analysing it (see the module docstring).
SYMBOL_BOX = (367, 190, 884, 733)
WORDMARK_BOX = (261, 806, 1000, 918)
# A vertical strip of clean panel used to model the background per row.
BG_STRIP = (100, 250)


def load_source() -> np.ndarray:
    if not SOURCE.exists():
        sys.exit(f"Source artwork not found: {SOURCE}")
    return np.asarray(Image.open(SOURCE).convert("RGB")).astype(float)


def cut_out(rgb: np.ndarray, lo: float = 30.0, hi: float = 70.0) -> Image.Image:
    """Separates artwork from the panel by distance from a per-row background."""
    background = np.median(rgb[:, BG_STRIP[0] : BG_STRIP[1], :], axis=1)
    distance = np.linalg.norm(rgb - background[:, None, :], axis=2)
    alpha = np.clip((distance - lo) / (hi - lo), 0.0, 1.0)
    return Image.fromarray(np.dstack([rgb, alpha * 255]).astype(np.uint8), "RGBA")


def trim(img: Image.Image) -> Image.Image:
    bbox = img.getchannel("A").getbbox()
    return img.crop(bbox) if bbox else img


def ground(size: int) -> Image.Image:
    """A full-bleed diagonal ground. Two stops, one hue — no glow, no vignette."""
    x = np.linspace(0.0, 1.0, size)
    t = np.clip((x[None, :] + x[:, None]) / 2.0, 0.0, 1.0)[..., None]
    rgb = np.array(GROUND_FROM) + (np.array(GROUND_TO) - np.array(GROUND_FROM)) * t
    return Image.fromarray(np.dstack([rgb, np.full((size, size), 255)]).astype(np.uint8), "RGBA")


def fit(img: Image.Image, width: int) -> Image.Image:
    height = max(1, round(img.height * width / img.width))
    return img.resize((width, height), Image.LANCZOS)


def place(canvas: Image.Image, art: Image.Image, cx: float, cy: float) -> None:
    """Pastes `art` centred on a fractional position of the canvas."""
    x = round(canvas.width * cx - art.width / 2)
    y = round(canvas.height * cy - art.height / 2)
    canvas.alpha_composite(art, (x, y))


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    kb = path.stat().st_size / 1024
    rel = path.relative_to(HERE.parent.parent.parent)
    print(f"{str(rel):44s} {img.width}x{img.height}  {kb:.1f}KB")


def main() -> None:
    rgb = load_source()
    cut = cut_out(rgb)
    symbol = trim(cut.crop(SYMBOL_BOX))
    wordmark = trim(cut.crop(WORDMARK_BOX))

    # --- app assets --------------------------------------------------------

    # Store / launcher icon: full bleed, the complete lockup, no baked corners.
    icon = ground(1024)
    place(icon, fit(symbol, 470), 0.5, 0.40)
    place(icon, fit(wordmark, 660), 0.5, 0.80)
    save(icon, APP_ASSETS / "icon.png")

    # Android adaptive foreground: symbol only, inside the mask safe zone. The
    # launcher crops this; anything beyond ~66% of the canvas can be cut.
    adaptive = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    place(adaptive, fit(symbol, 560), 0.5, 0.5)
    save(adaptive, APP_ASSETS / "adaptive-icon.png")

    splash = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    place(splash, fit(symbol, 400), 0.5, 0.5)
    save(splash, APP_ASSETS / "splash-icon.png")

    favicon = ground(64)
    place(favicon, fit(symbol, 46), 0.5, 0.5)
    save(favicon, APP_ASSETS / "favicon.png")

    # Used by the in-app <Logo> component.
    save(fit(symbol, 512), APP_ASSETS / "logo-symbol.png")

    # --- brand assets (documentation and marketing; never bundled) ---------

    save(symbol, BRAND / "symbol.png")
    save(wordmark, BRAND / "wordmark.png")

    lockup = ground(1200)
    place(lockup, fit(symbol, 520), 0.5, 0.38)
    place(lockup, fit(wordmark, 760), 0.5, 0.74)
    save(lockup, BRAND / "lockup-dark.png")

    on_light = Image.new("RGBA", (800, 800), (250, 250, 247, 255))
    place(on_light, fit(symbol, 520), 0.5, 0.5)
    save(on_light, BRAND / "symbol-on-light.png")


if __name__ == "__main__":
    main()
