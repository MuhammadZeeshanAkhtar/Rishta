"""
Derives every NikahMate brand asset from the supplied source artwork.

The source is one lockup on transparency: the heart symbol above the NikahMate
wordmark. A mobile app needs that split into several shapes, so this script
separates it and rebuilds each asset:

  * The app icon is composited onto a deep emerald ground. The supplied
    wordmark is emerald and gold, which would disappear on that ground, and a
    wordmark is not legible at launcher size in any case — so the icon carries
    the SYMBOL ALONE. The full lockup stays a brand asset for store listings
    and marketing, where it is seen large and on light.

  * The Android adaptive foreground sits inside the mask safe zone. The
    launcher crops it to a circle or squircle; anything near the edge is lost.

  * The in-app wordmark is live text in the Logo component, not an image, so it
    stays crisp and takes the theme.

Resolution: the script reports the upscale factor for every asset and warns
when one exceeds 1.5x. Upscaling cannot invent detail — a soft store icon means
the source needs to be exported larger, not resampled harder.

    python apps/mobile/scripts/build-brand-assets.py

Requires Pillow (a developer tool only — not an app dependency).
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
APP_ASSETS = HERE.parent / "assets"
BRAND = HERE.parent.parent.parent / "docs" / "brand"
REPO = HERE.parent.parent.parent
SOURCE = BRAND / "source" / "nikahmate-logo-source.png"

# Brand ground for the icon: emerald 900 -> 800, a two-stop diagonal.
#
# Deliberately deeper than the UI's brand gradient. One half of the heart is
# emerald, and on a mid-emerald ground that half sinks into the background and
# the mark reads as a gold swoosh. Keeping the ground near-black green holds
# both halves.
GROUND_FROM = (2, 32, 24)
GROUND_TO = (6, 78, 58)
WARM_WHITE = (250, 250, 247, 255)

# Regions of the source. The artwork already carries an alpha channel, so these
# are simply the two bands of content with the gap between them.
SYMBOL_BOX = (112, 108, 386, 350)
WORDMARK_BOX = (47, 363, 458, 426)

#: Flag any asset scaled beyond this. Past ~1.5x, resampling shows.
UPSCALE_WARN = 1.5

_warnings: list[str] = []


def load_source() -> Image.Image:
    if not SOURCE.exists():
        sys.exit(f"Source artwork not found: {SOURCE}")
    return Image.open(SOURCE).convert("RGBA")


def trim(img: Image.Image) -> Image.Image:
    bbox = img.getchannel("A").getbbox()
    return img.crop(bbox) if bbox else img


def ground(size: int) -> Image.Image:
    """A full-bleed diagonal ground. Two stops, one hue — no glow, no vignette."""
    import numpy as np

    x = np.linspace(0.0, 1.0, size)
    t = ((x[None, :] + x[:, None]) / 2.0)[..., None]
    rgb = np.array(GROUND_FROM) + (np.array(GROUND_TO) - np.array(GROUND_FROM)) * t
    return Image.fromarray(
        np.dstack([rgb, np.full((size, size), 255)]).astype(np.uint8), "RGBA"
    )


def fit(img: Image.Image, width: int, label: str) -> Image.Image:
    factor = width / img.width
    if factor > UPSCALE_WARN:
        _warnings.append(f"{label}: symbol upscaled {factor:.1f}x (source {img.width}px)")
    height = max(1, round(img.height * factor))
    return img.resize((width, height), Image.LANCZOS)


def place(canvas: Image.Image, art: Image.Image, cx: float, cy: float) -> None:
    x = round(canvas.width * cx - art.width / 2)
    y = round(canvas.height * cy - art.height / 2)
    canvas.alpha_composite(art, (x, y))


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    kb = path.stat().st_size / 1024
    print(f"{str(path.relative_to(REPO)):44s} {img.width}x{img.height}  {kb:.1f}KB")


def main() -> None:
    src = load_source()
    symbol = trim(src.crop(SYMBOL_BOX))
    wordmark = trim(src.crop(WORDMARK_BOX))
    print(f"source {src.width}x{src.height} — symbol {symbol.width}x{symbol.height}\n")

    # --- app assets --------------------------------------------------------

    icon = ground(1024)
    place(icon, fit(symbol, 620, "icon.png"), 0.5, 0.5)
    save(icon, APP_ASSETS / "icon.png")

    # Inside the Android mask safe zone: the launcher crops this.
    adaptive = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    place(adaptive, fit(symbol, 540, "adaptive-icon.png"), 0.5, 0.5)
    save(adaptive, APP_ASSETS / "adaptive-icon.png")

    splash = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    place(splash, fit(symbol, 400, "splash-icon.png"), 0.5, 0.5)
    save(splash, APP_ASSETS / "splash-icon.png")

    favicon = ground(64)
    place(favicon, fit(symbol, 44, "favicon.png"), 0.5, 0.5)
    save(favicon, APP_ASSETS / "favicon.png")

    # Used by the in-app <Logo>. 512 covers an 88dp render at 3x density with
    # room to spare, so the app never shows an upscaled mark.
    save(fit(symbol, 512, "logo-symbol.png"), APP_ASSETS / "logo-symbol.png")

    # --- brand assets (documentation and marketing; never bundled) ---------

    save(symbol, BRAND / "symbol.png")
    save(wordmark, BRAND / "wordmark.png")
    save(trim(src), BRAND / "lockup.png")

    on_light = Image.new("RGBA", (800, 800), WARM_WHITE)
    place(on_light, fit(symbol, 480, "symbol-on-light.png"), 0.5, 0.5)
    save(on_light, BRAND / "symbol-on-light.png")

    on_dark = ground(800)
    place(on_dark, fit(symbol, 480, "symbol-on-dark.png"), 0.5, 0.5)
    save(on_dark, BRAND / "symbol-on-dark.png")

    if _warnings:
        print("\nResolution notes:")
        for w in _warnings:
            print(f"  ! {w}")
        print(
            "  Resampling cannot add detail. For a genuinely sharp 1024 store\n"
            "  icon the symbol needs to be ~600px in the source; for print or a\n"
            "  4K render it needs to be vector (SVG/PDF) or ~2000px."
        )


if __name__ == "__main__":
    main()
