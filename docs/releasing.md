# Cutting a DevHotel release

The release is made **locally**; CI only proves the tagged commit builds and
passes. This is deliberate — see "Why not CI" below.

## Steps

1. **Bump** every `package.json` (root, `apps/desktop`, `packages/*`) plus
   `packages/mcp/src/metadata.ts` and its test. Use a Node script, never
   PowerShell `Set-Content -Encoding utf8`: it writes a BOM, and a BOM in any
   `package.json` breaks vite with `Unexpected token '﻿'`.
2. **Date the CHANGELOG**: `## Unreleased` → `## X.Y.Z — YYYY-MM-DD`.
3. **Verify**: `pnpm -r --if-present test && pnpm -r typecheck && pnpm lint`.
4. **Commit and tag**: `git commit -m "release: DevHotel X.Y.Z"`,
   `git tag vX.Y.Z`, `git push origin main vX.Y.Z`.
5. **Build the artifacts outside the repo** — electron-builder output inside
   the working tree trips folder watchers with EBUSY, and reusing a previous
   output directory fails the same way:

   ```
   pnpm build && pnpm --filter devhotel-mcp build
   pnpm --filter devhotel prepare:github
   cd apps/desktop
   pnpm exec electron-builder --win nsis \
     --config.directories.output="$LOCALAPPDATA/Temp/dh-release-X-Y-Z"
   ```

6. **Rename to the hyphenated names** electron-builder writes into
   `latest.yml` (`DevHotel-Setup-X.Y.Z.exe`, `…exe.blockmap`), then confirm the
   trio agrees before uploading anything:

   ```
   node -e "const c=require('crypto'),f=require('fs');const h=c.createHash('sha512');\
   h.update(f.readFileSync('DevHotel-Setup-X.Y.Z.exe'));\
   console.log(h.digest('base64')===/sha512: (.+)/.exec(f.readFileSync('latest.yml','utf8'))[1])"
   ```

   `latest.yml`'s sha512 **must** match the exe you upload, or auto-update
   rejects the download.
7. **Create the release and upload all three files together**:

   ```
   gh release create vX.Y.Z --title "X.Y.Z" --notes-file notes.md \
     "DevHotel-Setup-X.Y.Z.exe" "DevHotel-Setup-X.Y.Z.exe.blockmap" latest.yml
   ```

   Never mix CI-built and locally built artifacts in one release.
8. **Check the result**: `gh release list` should show your version as `Latest`
   and **no drafts**. `gh api repos/<owner>/<repo>/releases/latest` is what
   auto-update reads.

## Publishing an older release afterwards

Pass `make_latest=false`, or GitHub will move the `Latest` pointer backwards
and every installed app will "update" to the older build:

```
gh api -X PATCH repos/<owner>/<repo>/releases/<id> -f draft=false -f make_latest=false
```

## Why not CI

`electron-builder --publish always` creates a *new draft release* on every run.
Re-running a tag (or force-moving one after a fix) therefore leaves orphan
drafts behind — ten had accumulated by 0.4.3, and four early versions were
never published at all because their only release object stayed a draft. CI now
runs `--publish never`: it verifies, it does not release.

## Local install of the build you just shipped

Orca holds an open handle on `resources\app.asar` of any Electron app it has
seen, including DevHotel's install directory, which makes NSIS fail with
"Failed to uninstall old application files: 2". Stop DevHotel, probe the lock by
renaming `app.asar`, and if it is held, restart Orca before installing.
