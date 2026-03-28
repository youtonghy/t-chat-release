#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readCargoVersion(content) {
  const packageSection = content.match(/\[package\][\s\S]*?(?:\n\[|$)/);
  if (!packageSection) {
    throw new Error("Unable to locate [package] section in Cargo.toml");
  }
  const versionMatch = packageSection[0].match(/^\s*version\s*=\s*"([^"]+)"\s*$/m);
  if (!versionMatch) {
    throw new Error("Unable to locate package version in Cargo.toml");
  }
  return versionMatch[1];
}

async function getSourceSha(sourceDir) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: sourceDir,
  });
  return stdout.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(process.cwd(), args["source-dir"] ?? "source");

  const packageJsonPath = path.join(sourceDir, "package.json");
  const tauriConfigPath = path.join(sourceDir, "src-tauri", "tauri.conf.json");
  const cargoTomlPath = path.join(sourceDir, "src-tauri", "Cargo.toml");

  const [packageJsonRaw, tauriConfigRaw, cargoTomlRaw] = await Promise.all([
    fs.readFile(packageJsonPath, "utf8"),
    fs.readFile(tauriConfigPath, "utf8"),
    fs.readFile(cargoTomlPath, "utf8"),
  ]);

  const packageJson = JSON.parse(packageJsonRaw);
  const tauriConfig = JSON.parse(tauriConfigRaw);
  const cargoVersion = readCargoVersion(cargoTomlRaw);

  const versions = [
    ["package.json", packageJson.version],
    ["src-tauri/tauri.conf.json", tauriConfig.version],
    ["src-tauri/Cargo.toml", cargoVersion],
  ];

  const distinctVersions = new Set(versions.map((entry) => entry[1]));
  if (distinctVersions.size !== 1) {
    const details = versions
      .map(([file, version]) => `${file}=${version ?? "<missing>"}`)
      .join(", ");
    throw new Error(`Version mismatch detected: ${details}`);
  }

  const version = versions[0][1];
  const productName = tauriConfig.productName ?? packageJson.name ?? "T-Chat";
  const productSlug = slugify(productName || "t-chat");
  const sourceSha = await getSourceSha(sourceDir);

  const result = {
    version,
    tag_name: `v${version}`,
    release_name: `${productName} v${version}`,
    product_name: productName,
    product_slug: productSlug,
    source_sha: sourceSha,
  };

  if (args["github-output"]) {
    const lines = Object.entries(result)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    await fs.appendFile(args["github-output"], `${lines}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
