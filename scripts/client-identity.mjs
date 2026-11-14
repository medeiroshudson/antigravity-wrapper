#!/usr/bin/env node
/**
 * Resolves the Antigravity client identity — version and build CL — from the public
 * updater manifest, so a build never claims a frozen version.
 *
 * Measured 2026-11-14 by intercepting `agy update` with a local CA:
 *
 *   GET  <updater>/manifests/<os>_<arch>.json  ->  { version, url, sha512 }
 *   GET  <url>                                 ->  the CLI tarball (single file: antigravity)
 *
 * The manifest publishes the version but not the CL the client puts in its User-Agent
 * (`cl=`). `agy` has no `--stamp`, so the CL is read out of the binary: it is a literal
 * matching ^10\d{8}$, next to the Go toolchain's CL and a few numeric constants. Validated
 * against the two versions whose UA was observed directly:
 *
 *   1.5.3 -> 1016078699    1.5.9 -> 1021519450
 *
 * The extraction is a heuristic with a guard, not a guarantee: it refuses an empty set and
 * refuses a CL that does not move forward, so a change in the binary layout fails the build
 * instead of silently publishing a stale identity. The definitive check stays running the
 * client once and reading the UA it sends.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const UPDATER_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";

/** The Go toolchain's own CL, present in the build-info string of every binary. */
export const GO_CL_PATTERN = /cl\/(\d{9,11})/;

/** CL literals are ten digits starting with 10 (observed: 1016078699, 1021519450). */
export const CL_CANDIDATE_PATTERN = /(?<![0-9])10\d{8}(?![0-9])/g;

/** Numeric constants the runtime embeds that also match the candidate pattern. */
export const CL_CONSTANTS = new Set(["1000000000", "1073741824"]);

/**
 * The CL from a client binary: candidates minus the runtime constants and the toolchain's
 * own CL, highest first. Exported for tests; the layout can only be validated against
 * versions whose UA was captured.
 */
export function extractBuildCl(binary) {
  const text = binary.toString("latin1");
  const goCl = GO_CL_PATTERN.exec(text)?.[1] ?? null;
  const candidates = new Set(text.match(CL_CANDIDATE_PATTERN) ?? []);
  const considered = [...candidates].sort();
  const filtered = considered.filter((value) => !CL_CONSTANTS.has(value) && value !== goCl);
  return { goCl, candidates: considered, filtered, cl: filtered.length > 0 ? filtered[filtered.length - 1] : null };
}

export async function fetchManifest(platform, fetchImpl = fetch) {
  const url = `${UPDATER_BASE}/manifests/${platform}.json`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`manifest ${platform}: HTTP ${response.status}`);
  const data = await response.json();
  for (const field of ["version", "url", "sha512"]) {
    if (typeof data?.[field] !== "string" || data[field].length === 0) {
      throw new Error(`manifest ${platform}: missing ${field} in ${JSON.stringify(data).slice(0, 120)}`);
    }
  }
  return data;
}

export function verifySha512(buffer, expected) {
  const actual = createHash("sha512").update(buffer).digest("hex");
  if (actual !== expected) throw new Error(`sha512 mismatch: got ${actual}, manifest says ${expected}`);
  return actual;
}

/** The tarball holds one file; extract it in a private temp dir and discard the archive. */
export function extractBinary(tarball) {
  const dir = mkdtempSync(join(tmpdir(), "agw-identity-"));
  try {
    const archive = join(dir, "cli.tar.gz");
    writeFileSync(archive, tarball);
    execFileSync("tar", ["xzf", archive, "-C", dir], { stdio: "pipe" });
    return readFileSync(join(dir, "antigravity"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function resolveIdentity(platform = "linux_amd64", opts = {}) {
  const manifest = await fetchManifest(platform, opts.fetchImpl ?? fetch);
  const response = await (opts.fetchImpl ?? fetch)(manifest.url);
  if (!response.ok) throw new Error(`download ${manifest.url}: HTTP ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  verifySha512(tarball, manifest.sha512);

  const binary = extractBinary(tarball);
  if (!binary.includes(manifest.version)) {
    throw new Error(`binary does not contain its own version ${manifest.version}`);
  }
  const { cl } = extractBuildCl(binary);
  if (cl === null) throw new Error("could not extract the build CL from the client binary");

  if (opts.previous !== null && opts.previous !== undefined && Number.isFinite(opts.previous) && opts.previous > 0) {
    if (Number(cl) <= opts.previous) {
      throw new Error(`CL did not move forward: ${cl} <= ${opts.previous}; refusing to publish a stale identity`);
    }
  }
  return { platform, version: manifest.version, cl };
}

function parseArgs(argv) {
  const platform = argv.find((arg) => !arg.startsWith("--")) ?? "linux_amd64";
  const previousArg = argv.find((arg) => arg.startsWith("--previous="));
  const previous = previousArg === undefined ? null : Number(previousArg.slice("--previous=".length));
  return { platform, previous: Number.isFinite(previous) ? previous : null, json: argv.includes("--json") };
}

const invokedDirectly = process.argv[1]?.endsWith("client-identity.mjs") ?? false;
if (invokedDirectly) {
  const { platform, previous, json } = parseArgs(process.argv.slice(2));
  resolveIdentity(platform, { previous })
    .then((identity) => {
      if (json) console.log(JSON.stringify(identity));
      else console.log(`version=${identity.version}\ncl=${identity.cl}`);
    })
    .catch((error) => {
      console.error(`client-identity: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
