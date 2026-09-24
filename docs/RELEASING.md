# Publishing PodHarbor

The public repository is https://github.com/Banegasn/podharbor.
The website is https://banegasn.github.io/podharbor/ and publishes from `main:/docs`.

## Release a version

With Node.js 24+, pnpm 12.6.0, Rust, and the Tauri system dependencies installed:

```sh
pnpm install --frozen-lockfile
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml
./release.sh --dry-run 0.2.0
./release.sh 0.2.0
```

Commit your changes first. The script checks for a clean working tree and existing tags,
updates the three package versions and Cargo lockfile, then commits and pushes the branch
and version tag atomically. For the initial release at the existing version use
`./release.sh --no-commit 0.1.0`.

The tag must match all package versions. Manual Actions runs must select an existing version tag.
The workflow builds macOS Apple Silicon and Intel DMGs, Windows x64 installers,
and Linux x64 and ARM64 DEB/RPM packages. It uploads to a draft release and publishes
only after all five builds succeed. If a build fails, rerun failed jobs on the same tag;
the release stays in draft until the matrix succeeds.

Only the automatic repository `GITHUB_TOKEN` is required. macOS builds use ad-hoc signing,
matching S3 Studio; they are not notarized. Windows installers are not certificate-signed.
The operating system may require explicit approval to open them. Distribution certificates
and notarization can be configured later using the Tauri signing documentation.

## Website

Edit the static files in `docs/` and push `main`. GitHub Pages publishes that directory.
The download button links to the latest complete release. Website changes do not create a release.
