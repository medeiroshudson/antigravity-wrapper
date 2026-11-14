import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CL_CONSTANTS,
  extractBuildCl,
  fetchManifest,
  verifySha512,
} from "../scripts/client-identity.mjs";

/** A buffer shaped like the client binary: build-info CL, runtime constants, candidates. */
function binaryOf(...numbers: string[]): Buffer {
  return Buffer.from(`go1.28 cl/1012564305 ${numbers.join(" ")}`, "latin1");
}

describe("extractBuildCl", () => {
  it("picks the client CL, excluding the toolchain CL and the runtime constants", () => {
    // Measured shapes: 1.5.3 -> 1016078699, 1.5.9 -> 1021519450.
    const older = extractBuildCl(binaryOf("1000000000", "1008462968", "1016078699", "1073741824"));
    expect(older.cl).toBe("1016078699");

    const newer = extractBuildCl(binaryOf("1000000000", "1012501748", "1021519450", "1073741824"));
    expect(newer.cl).toBe("1021519450");
  });

  it("never returns a runtime constant or the toolchain's own CL", () => {
    const { cl, filtered, goCl } = extractBuildCl(binaryOf("1000000000", "1073741824"));
    expect(goCl).toBe("1012564305");
    expect(cl).toBeNull();
    expect(filtered).toEqual([]);
    for (const constant of CL_CONSTANTS) expect(filtered).not.toContain(constant);
  });

  it("returns null instead of guessing when the layout changes", () => {
    expect(extractBuildCl(Buffer.from("no numbers here", "latin1")).cl).toBeNull();
  });
});

describe("verifySha512", () => {
  it("accepts the published digest and rejects anything else", () => {
    const tarball = Buffer.from("tarball", "latin1");
    const digest = createHash("sha512").update(tarball).digest("hex");
    expect(verifySha512(tarball, digest)).toBe(digest);
    expect(() => verifySha512(tarball, "0".repeat(128))).toThrow(/sha512 mismatch/);
  });
});

describe("fetchManifest", () => {
  it("returns the manifest when the shape is right", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ version: "1.5.9", url: "https://example/x.tar.gz", sha512: "abc" }),
    })) as unknown as typeof fetch;
    await expect(fetchManifest("linux_amd64", fetchImpl)).resolves.toMatchObject({ version: "1.5.9" });
  });

  it("fails loudly on a non-200 or a missing field", async () => {
    const notFound = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(fetchManifest("linux_amd64", notFound)).rejects.toThrow(/HTTP 404/);

    const missing = (async () => ({
      ok: true,
      json: async () => ({ version: "1.5.9" }),
    })) as unknown as typeof fetch;
    await expect(fetchManifest("linux_amd64", missing)).rejects.toThrow(/missing url/);
  });
});
