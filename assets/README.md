# Assets Directory

This directory stores images generated with Cursor 2.4's Image Generation feature.

## Purpose

- **UI mockups**: mobile app UI design mockups
- **Architecture diagrams**: visualizations of the system architecture
- **Product assets**: project-related image assets

## How to generate

Ask the Cursor agent to generate an image:
```
"Generate an architecture diagram showing the Cursor Remote system components:
- Mobile App (Flutter)
- Extension (TypeScript)
- Relay Server (Vercel)"
```

Or use the slash command:
```
/image "Create a UI mockup for the mobile app's session management screen"
```

## File naming

- `architecture-*.png`: architecture diagrams
- `ui-mockup-*.png`: UI mockups
- `diagram-*.png`: general diagrams
- `asset-*.png`: product assets

## Git

Image files are not committed to Git (adding them to `.gitignore` is recommended).

Instead:
- Reference important diagrams from the docs
- Add image descriptions to README.md

---

**Last updated**: 2026-01-26
