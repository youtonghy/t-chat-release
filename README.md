# T-Chat Public Release Orchestrator

This repository template is intended for a separate public GitHub repository that builds and publishes release assets for the private `T-Chat` source repository.

## Purpose

- Keep the application source code in a private repository.
- Keep the build workflow and release page in a public repository.
- Build the private source repository on demand from a branch, tag, or commit SHA.
- Publish macOS, Windows, and Linux installers to the public repository releases.
- Generate release notes from the new commit subjects introduced since the previous published release.

## Repository Layout

- `.github/workflows/build-release.yml`: workflow entrypoint
- `scripts/resolve-version.mjs`: validate and export app version metadata from the private source tree
- `scripts/collect-release-notes.mjs`: compute release notes and release state from source history plus existing releases
- `scripts/publish-release.mjs`: create/update the GitHub release, upload assets, and publish a release manifest

## Required Secrets

- `PRIVATE_REPO`: full private repository name, for example `owner/T-Chat`
- `PRIVATE_REPO_PAT`: fine-grained personal access token with read access to the private repository contents

## Workflow Inputs

- `source_ref`: required, branch/tag/SHA in the private repository
- `release_draft`: optional, defaults to `false`
- `prerelease`: optional, defaults to `false`

## Release Rules

- The source version is read from:
  - `package.json`
  - `src-tauri/tauri.conf.json`
  - `src-tauri/Cargo.toml`
- All three version values must match.
- The public release tag is `v<version>`.
- If `v<version>` already exists:
  - same `source_sha`: rerun is allowed and assets are replaced
  - different `source_sha`: workflow fails and the source version must be bumped first
- The release body includes a machine-readable metadata block with:
  - `source_repo`
  - `source_ref`
  - `source_sha`

## Release Notes

- Commit subjects are collected from the private source repository.
- The range starts at the `source_sha` recorded in the previous release metadata.
- The current release uses the checked out source `HEAD`.
- Merge commits are skipped.
- Duplicate subjects are removed.
- The original subject text is preserved without rewriting.

## Assets

The workflow builds these targets:

- macOS ARM64: `aarch64-apple-darwin`
- Windows x64: `x86_64-pc-windows-msvc`
- Windows ARM64: `aarch64-pc-windows-msvc`
- Linux x64: `x86_64-unknown-linux-gnu`
- Linux ARM64: `aarch64-unknown-linux-gnu`

Each workflow run uploads the build bundles as intermediate artifacts and then republishes normalized release asset names that include version, OS, and architecture.

## Setup

1. Create a new public repository.
2. Copy this template into the root of that repository.
3. Add the required secrets in the public repository settings.
4. Run the workflow manually from the Actions tab with `source_ref`.

## Troubleshooting

- `Version mismatch`: fix the source version in the private repository before retrying.
- `Existing release points to a different source_sha`: bump the source version before releasing another commit.
- `No bundle assets found`: inspect the matrix job logs and confirm the Tauri build produced installers for that target.
- `Private repository checkout failed`: verify `PRIVATE_REPO` and `PRIVATE_REPO_PAT`.
