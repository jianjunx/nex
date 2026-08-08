#!/usr/bin/env node
/**
 * Create and push a release tag to trigger .github/workflows/release.yml.
 *
 * Usage:
 *   pnpm run tag -- 1.1.1
 *   pnpm run tag -- v1.1.1
 *   pnpm run tag -- release-v1.1.1
 *   pnpm run tag -- --1.1.1
 */
import { execSync } from "node:child_process";

function usage(exitCode = 1) {
  console.error(`Usage: pnpm run tag -- <version>
Examples:
  pnpm run tag -- 1.1.1
  pnpm run tag -- v1.1.1
  pnpm run tag -- release-v1.1.1

Creates tag release-vX.Y.Z and pushes it to origin (triggers GitHub Actions Release).`);
  process.exit(exitCode);
}

/** Normalize CLI arg to X.Y.Z (matches release.yml). */
function normalizeVersion(raw) {
  let s = String(raw).trim();
  // Allow `--1.1.1` / `-1.1.1` style args.
  s = s.replace(/^--+/, "");
  s = s.replace(/^release-v/i, "");
  s = s.replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(s)) {
    throw new Error(
      `Invalid version '${raw}'. Expected X.Y.Z (e.g. 1.1.1), matching release-vX.Y.Z.`,
    );
  }
  return s;
}

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

function tagExistsLocally(tag) {
  try {
    execSync(`git rev-parse -q --verify "refs/tags/${tag}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2).filter((a) => a !== "--");
if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  usage(args.length === 0 ? 1 : 0);
}

let version;
try {
  version = normalizeVersion(args[0]);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  usage(1);
}

const tag = `release-v${version}`;

if (tagExistsLocally(tag)) {
  console.error(`Tag ${tag} already exists locally. Delete it first if you intend to recreate.`);
  process.exit(1);
}

console.log(`Creating tag ${tag}…`);
run(`git tag "${tag}"`);

console.log(`Pushing ${tag} to origin…`);
run(`git push origin "refs/tags/${tag}"`);

console.log(`Done. Pushed ${tag} — GitHub Actions Release should start shortly.`);
