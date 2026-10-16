#!/usr/bin/env python3
"""Ricoh GR IV (v1.11) 40x40 RGBA Image Control Icon Generator for 'HLG'.

Generates a crisp 40x40 RGBA bitmap icon for the HLG Image Control slot in the
camera's UI (ADJ bar, Image Control menu, playback info, shooting overlay):
  - Dimensions: 40 x 40 pixels (1600 pixels, 6400 bytes RGBA).
  - Background: transparent (A=0, RGB=(255, 255, 255)).
  - Foreground: solid white / light grey (A=255, RGB=(255, 255, 255)) with anti-aliasing.
  - Text: "HLG" in bold condensed modern sans-serif typography.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def generate_hlg_icon(width: int = 40, height: int = 40) -> Image.Image:
    # 40x40 transparent RGBA canvas
    img = Image.new("RGBA", (width, height), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)

    # Rounded rectangle outline badge / container
    # Badge margins: x: 1..38, y: 5..35
    badge_box = [2, 6, 37, 33]
    draw.rounded_rectangle(badge_box, radius=4, outline=(240, 240, 240, 255), width=2)

    # Draw "HLG" text
    # Try system fonts or fallback to bitmap/default font
    font = None
    for font_name in ["arialbd.ttf", "segoeuib.ttf", "tahomabd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf"]:
        try:
            font = ImageFont.truetype(font_name, size=15)
            break
        except Exception:
            pass

    if font is None:
        font = ImageFont.load_default()

    text = "HLG"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (width - tw) // 2 - bbox[0]
    ty = (height - th) // 2 - bbox[1] - 1

    draw.text((tx, ty), text, fill=(255, 255, 255, 255), font=font)
    return img


def to_raw_rgba_bytes(img: Image.Image) -> bytes:
    """Format as camera ICONBIN 40x40 RGBA: transparent as FF FF FF 00."""
    out = bytearray()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = img.getpixel((x, y))
            if a == 0:
                out.extend([255, 255, 255, 0])
            else:
                out.extend([r, g, b, a])
    return bytes(out)


def main():
    worktree_root = Path(__file__).resolve().parent.parent.parent
    icon_dir = worktree_root / "assets" / "icons"
    icon_dir.mkdir(parents=True, exist_ok=True)

    icon_img = generate_hlg_icon(40, 40)
    png_path = icon_dir / "hlg_slot_icon_40x40.png"
    icon_img.save(png_path)

    raw_bytes = to_raw_rgba_bytes(icon_img)
    bin_path = icon_dir / "hlg_slot_icon_40x40.bin"
    bin_path.write_bytes(raw_bytes)

    print(f"Generated 40x40 HLG icon ({len(raw_bytes)} bytes):")
    print(f"  - PNG: {png_path}")
    print(f"  - Raw RGBA: {bin_path}")
    return 0


if __name__ == "__main__":
    main()
