#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const METADATA_START = "<!-- release-metadata";
const METADATA_END = "-->";

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

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${body}`);
  }

  return response.json();
}

function parseMetadata(body) {
  if (!body) {
    return null;
  }
  const start = body.indexOf(METADATA_START);
  if (start === -1) {
    return null;
  }
  const end = body.indexOf(METADATA_END, start);
  if (end === -1) {
    return null;
  }
  const raw = body
    .slice(start + METADATA_START.length, end)
    .trim();
  if (!raw) {
    return null;
  }
  return JSON.parse(raw);
}

async function git(sourceDir, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: sourceDir,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function commitExists(sourceDir, sha) {
  try {
    await git(sourceDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function collectCommitSubjects(sourceDir, previousSha, currentSha) {
  const rangeArgs = previousSha
    ? ["log", "--reverse", "--format=%H%x1f%s%x1f%P%x1e", `${previousSha}..${currentSha}`]
    : ["log", "--reverse", "--format=%H%x1f%s%x1f%P%x1e", currentSha];
  const raw = await git(sourceDir, rangeArgs);
  const records = raw
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, parents = ""] = entry.split("\x1f");
      return {
        sha,
        subject: subject?.trim() ?? "",
        parentCount: parents.trim() ? parents.trim().split(/\s+/).length : 0,
      };
    });

  const seen = new Set();
  const subjects = [];
  for (const record of records) {
    if (!record.subject) {
      continue;
    }
    if (record.parentCount > 1) {
      continue;
    }
    if (seen.has(record.subject)) {
      continue;
    }
    seen.add(record.subject);
    subjects.push(record.subject);
  }
  return subjects;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(process.cwd(), args["source-dir"] ?? "source");
  const publicRepoFullName = process.env.GITHUB_REPOSITORY;
  if (!publicRepoFullName) {
    throw new Error("GITHUB_REPOSITORY is required");
  }

  const publicRepo = parseRepo(publicRepoFullName);
  const sourceRepo = args["source-repo"];
  const sourceRef = args["source-ref"];
  const version = args["version"];
  const tagName = args["tag-name"];
  const releaseName = args["release-name"];
  const productName = args["product-name"];
  const productSlug = args["product-slug"];
  const outputPath = path.resolve(process.cwd(), args.output ?? "release-context.json");

  if (!sourceRepo || !sourceRef || !version || !tagName || !releaseName || !productName || !productSlug) {
    throw new Error("Missing required arguments for release note collection");
  }

  const currentSha = await git(sourceDir, ["rev-parse", "HEAD"]);
  const currentRelease = await githubRequest(
    `https://api.github.com/repos/${publicRepo.owner}/${publicRepo.repo}/releases/tags/${encodeURIComponent(tagName)}`
  );

  const currentMetadata = parseMetadata(currentRelease?.body ?? "");
  if (currentRelease && !currentMetadata?.source_sha) {
    throw new Error(`Release ${tagName} already exists but does not contain release metadata`);
  }
  if (currentRelease && currentMetadata?.source_sha && currentMetadata.source_sha !== currentSha) {
    throw new Error(
      `Release ${tagName} already exists for source_sha ${currentMetadata.source_sha}; current source is ${currentSha}`
    );
  }

  const releases =
    (await githubRequest(
      `https://api.github.com/repos/${publicRepo.owner}/${publicRepo.repo}/releases?per_page=100`
    )) ?? [];

  let previousRelease = null;
  for (const release of releases) {
    if (release.tag_name === tagName) {
      continue;
    }
    const metadata = parseMetadata(release.body ?? "");
    if (!metadata?.source_sha) {
      continue;
    }
    previousRelease = {
      id: release.id,
      tag_name: release.tag_name,
      source_sha: metadata.source_sha,
    };
    break;
  }

  const previousSha = previousRelease?.source_sha ?? null;
  if (previousSha && !(await commitExists(sourceDir, previousSha))) {
    throw new Error(`Previous release source_sha ${previousSha} is not reachable in the checked out source history`);
  }

  const subjects = await collectCommitSubjects(sourceDir, previousSha, currentSha);

  const result = {
    version,
    tagName,
    releaseName,
    productName,
    productSlug,
    sourceRepo,
    sourceRef,
    sourceSha: currentSha,
    previousSourceSha: previousSha,
    existingReleaseId: currentRelease?.id ?? null,
    notes: subjects,
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
