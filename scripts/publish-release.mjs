#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const METADATA_START = "<!-- release-metadata";
const METADATA_END = "-->";
const RELEASE_ASSET_EXTENSIONS = [
  ".app.tar.gz",
  ".AppImage",
  ".deb",
  ".dmg",
  ".exe",
  ".msi",
  ".rpm",
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function parseRepo(fullName) {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner, repo };
}

function parseBoolean(value) {
  return String(value).toLowerCase() === "true";
}

async function githubRequest(url, init = {}) {
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GH_TOKEN is required");
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "t-chat-release-orchestrator",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  return response.json();
}

async function walkFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath)));
      continue;
    }
    files.push(absolutePath);
  }
  return files;
}

function getExtension(filename) {
  const matched = RELEASE_ASSET_EXTENSIONS.find((extension) => filename.endsWith(extension));
  if (matched) {
    return matched;
  }
  return path.extname(filename);
}

function mapAssetType(extension) {
  switch (extension) {
    case ".dmg":
      return "dmg";
    case ".app.tar.gz":
      return "app-tar-gz";
    case ".msi":
      return "msi";
    case ".exe":
      return "exe";
    case ".deb":
      return "deb";
    case ".rpm":
      return "rpm";
    case ".AppImage":
      return "appimage";
    default:
      return extension.replace(/^\./, "") || "bin";
  }
}

function createAssetName(productSlug, version, osKey, archKey, extension) {
  return `${productSlug}_${version}_${osKey}_${archKey}${extension}`;
}

function formatDisplayName(asset) {
  return `${asset.os}/${asset.arch} ${asset.assetType}`;
}

async function collectReleaseAssets(artifactsDir, productSlug, version) {
  const allFiles = await walkFiles(artifactsDir);
  const assets = [];
  for (const absolutePath of allFiles) {
    const relativePath = path.relative(artifactsDir, absolutePath);
    const topLevel = relativePath.split(path.sep)[0] ?? "";
    const match = /^bundle-([^-]+)-([^-]+)$/.exec(topLevel);
    if (!match) {
      continue;
    }
    const fileName = path.basename(absolutePath);
    const extension = getExtension(fileName);
    if (!RELEASE_ASSET_EXTENSIONS.includes(extension)) {
      continue;
    }
    const [, osKey, archKey] = match;
    const assetType = mapAssetType(extension);
    assets.push({
      absolutePath,
      relativePath,
      os: osKey,
      arch: archKey,
      assetType,
      uploadName: createAssetName(productSlug, version, osKey, archKey, extension),
    });
  }
  return assets.sort((left, right) => left.uploadName.localeCompare(right.uploadName));
}

function buildReleaseBody(context, assets) {
  const lines = [
    "## Build Summary",
    "",
    `- Version: ${context.version}`,
    `- Source repository: ${context.sourceRepo}`,
    `- Source ref: ${context.sourceRef}`,
    `- Source SHA: ${context.sourceSha}`,
    `- Built at: ${context.generatedAt}`,
    "",
    "## Intro",
    "",
  ];

  if (context.notes.length === 0) {
    lines.push("- No new non-merge commits were found in the selected release range.");
  } else {
    for (const subject of context.notes) {
      lines.push(`- ${subject}`);
    }
  }

  lines.push("", "## Assets", "");
  if (assets.length === 0) {
    lines.push("- No release assets were detected.");
  } else {
    const assetLines = Array.from(new Set(assets.map(formatDisplayName)));
    for (const line of assetLines) {
      lines.push(`- ${line}`);
    }
  }

  const metadata = {
    source_repo: context.sourceRepo,
    source_ref: context.sourceRef,
    source_sha: context.sourceSha,
  };
  lines.push("", `${METADATA_START}`, JSON.stringify(metadata, null, 2), `${METADATA_END}`);
  return lines.join("\n");
}

async function loadReleaseByTag(repo, tagName) {
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GH_TOKEN is required");
  }
  const response = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/tags/${encodeURIComponent(tagName)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "t-chat-release-orchestrator",
      },
    }
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${body}`);
  }
  return response.json();
}

async function createRelease(repo, context, body, draft, prerelease) {
  return githubRequest(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tag_name: context.tagName,
      name: context.releaseName,
      body,
      draft,
      prerelease,
    }),
  });
}

async function updateRelease(repo, releaseId, context, body, draft, prerelease) {
  return githubRequest(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/${releaseId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: context.releaseName,
      body,
      draft,
      prerelease,
    }),
  });
}

async function deleteAsset(repo, assetId) {
  await githubRequest(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/assets/${assetId}`, {
    method: "DELETE",
  });
}

async function uploadAsset(uploadUrl, assetPath, uploadName, contentType) {
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GH_TOKEN is required");
  }
  const data = await fs.readFile(assetPath);
  const cleanUrl = uploadUrl.replace(/\{.*$/, "");
  const targetUrl = `${cleanUrl}?name=${encodeURIComponent(uploadName)}`;
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "Content-Length": String(data.byteLength),
      "User-Agent": "t-chat-release-orchestrator",
    },
    body: data,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Asset upload failed for ${uploadName} (${response.status}): ${body}`);
  }
}

function guessContentType(extension) {
  switch (extension) {
    case ".dmg":
      return "application/x-apple-diskimage";
    case ".app.tar.gz":
      return "application/gzip";
    case ".msi":
      return "application/x-msi";
    case ".exe":
      return "application/vnd.microsoft.portable-executable";
    case ".deb":
      return "application/vnd.debian.binary-package";
    case ".rpm":
      return "application/x-rpm";
    case ".AppImage":
      return "application/octet-stream";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const contextPath = path.resolve(process.cwd(), args["context-file"] ?? "release-context.json");
  const artifactsDir = path.resolve(process.cwd(), args["artifacts-dir"] ?? "artifacts");
  const draft = parseBoolean(args.draft ?? "false");
  const prerelease = parseBoolean(args.prerelease ?? "false");

  const publicRepoFullName = process.env.GITHUB_REPOSITORY;
  if (!publicRepoFullName) {
    throw new Error("GITHUB_REPOSITORY is required");
  }

  const repo = parseRepo(publicRepoFullName);
  const context = JSON.parse(await fs.readFile(contextPath, "utf8"));
  const assets = await collectReleaseAssets(artifactsDir, context.productSlug, context.version);
  if (assets.length === 0) {
    throw new Error("No release assets were found in the downloaded artifacts");
  }

  const manifest = {
    version: context.version,
    tag_name: context.tagName,
    release_name: context.releaseName,
    source_repo: context.sourceRepo,
    source_ref: context.sourceRef,
    source_sha: context.sourceSha,
    generated_at: context.generatedAt,
    assets: assets.map((asset) => ({
      name: asset.uploadName,
      os: asset.os,
      arch: asset.arch,
      type: asset.assetType,
      source_path: asset.relativePath,
    })),
  };
  const manifestPath = path.join(path.dirname(contextPath), "release-manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const releaseBody = buildReleaseBody(context, assets);
  let release = await loadReleaseByTag(repo, context.tagName);
  if (!release) {
    release = await createRelease(repo, context, releaseBody, draft, prerelease);
  }
  release = await updateRelease(repo, release.id, context, releaseBody, draft, prerelease);

  const existingAssets = release.assets ?? [];
  const byName = new Map(existingAssets.map((asset) => [asset.name, asset.id]));

  for (const asset of [...assets, { absolutePath: manifestPath, uploadName: "release-manifest.json" }]) {
    const existingId = byName.get(asset.uploadName);
    if (existingId) {
      await deleteAsset(repo, existingId);
    }
    const extension = getExtension(asset.uploadName);
    await uploadAsset(
      release.upload_url,
      asset.absolutePath,
      asset.uploadName,
      guessContentType(extension)
    );
  }

  process.stdout.write(`Published ${context.tagName} with ${assets.length + 1} assets.\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
