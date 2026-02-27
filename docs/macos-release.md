# macOS Release Notes

## Build from GitHub Actions

1. Open the workflow: `.github/workflows/build-macos-release.yml`
2. Run `Build macOS Release` with **Run workflow**.
3. Download both artifacts:
   - `yanshu-macos-arm64`
   - `yanshu-macos-x64`

Each artifact is an unsigned `.app` zip with bundled Python runtime and agent dependencies.

## First launch on user Mac

Unsigned apps may be blocked by Gatekeeper. Use one of:

- Right click app -> `Open`
- Or run:

```bash
xattr -dr com.apple.quarantine 焱书.app
```

## Packaging guarantees

- Runtime is self-contained (`python_embed` is bundled)
- No project DB or API keys are shipped in the app bundle
- User data is initialized on first run under:
  - `~/Library/Application Support/sanhuoai`

