# Icon Requirements

The Marketplace listing for `krishnagupta653.cursor-remote-extension` needs the following icon files.

## Required files

### 1. icon.png (required)
- **Location**: `cursor-extension/icon.png`, referenced by `"icon": "icon.png"` in `package.json`
- **Size**: 128x128px (minimum), 256x256px (recommended)
- **Format**: PNG (transparent background recommended; SVG is not accepted as the extension icon)
- **Used for**: the Marketplace and the extension list

The source artwork is `images/icon.svg`; export it to `icon.png` when the design changes.

### 2. banner.png (optional)
- **Size**: 1280x640px (recommended)
- **Format**: PNG or JPG
- **Used for**: a banner in the README

## Icon design guidelines

1. **Simple, clear design**: must be recognizable at small sizes
2. **Brand colors**: keep a consistent color theme
3. **High resolution**: consider Retina displays and design at 2x size
4. **Transparent background**: use PNG with a transparent background

## Icon tools

- [Figma](https://figma.com)
- [Canva](https://canva.com)
- [GIMP](https://gimp.org)
- [Adobe Illustrator](https://adobe.com/illustrator)

## Notes

Without an icon file, `vsce package` prints a warning. The package still builds, but the
Marketplace shows a default icon when the extension is published.

---

**Last updated**: 2026-10-09
