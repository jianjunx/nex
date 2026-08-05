import { beforeEach, describe, expect, it, vi } from "vitest";

const openFile = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../stores/fs.store", () => ({
  useFsStore: { getState: () => ({ openFile }) },
}));

vi.mock("../../../stores/project.store", () => ({
  useProjectStore: {
    getState: () => ({
      activeProjectId: "p1",
      projects: [{ id: "p1", path: "D:\\projects\\nex", name: "nex" }],
    }),
  },
}));

import {
  looksLikeFilePath,
  normalizePathForCompare,
  openPathToken,
  pathFromToolRawInput,
  resolveTokenPath,
} from "./pathToken";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("looksLikeFilePath", () => {
  it("accepts relative and Windows absolute paths", () => {
    expect(looksLikeFilePath("src/foo.ts")).toBe(true);
    expect(looksLikeFilePath("git.store.test.ts")).toBe(true);
    expect(looksLikeFilePath("D:\\projects\\nex\\src\\stores\\git.store.test.ts")).toBe(true);
    expect(looksLikeFilePath("D:/projects/nex/src/foo.ts:12")).toBe(true);
  });

  it("rejects URLs and bare words", () => {
    expect(looksLikeFilePath("https://example.com/a.ts")).toBe(false);
    expect(looksLikeFilePath("Edit File")).toBe(false);
  });
});

describe("resolveTokenPath", () => {
  it("resolves relative paths against the project root", () => {
    const r = resolveTokenPath("src/stores/git.store.test.ts");
    expect(r?.absPath.replace(/\//g, "\\")).toBe(
      "D:\\projects\\nex\\src\\stores\\git.store.test.ts",
    );
  });

  it("accepts Windows absolute paths inside the project", () => {
    const r = resolveTokenPath("D:\\projects\\nex\\src\\foo.ts");
    expect(r?.absPath.replace(/\//g, "\\").toLowerCase()).toBe(
      "d:\\projects\\nex\\src\\foo.ts",
    );
  });

  it("parses :line suffix without treating drive letters as lines", () => {
    expect(resolveTokenPath("src/a.ts:42")?.line).toBe(42);
    expect(resolveTokenPath("D:\\projects\\nex\\src\\a.ts")?.line).toBeUndefined();
  });

  it("rejects paths outside the project root", () => {
    expect(resolveTokenPath("D:\\other\\secret.ts")).toBeNull();
    expect(resolveTokenPath("../../etc/passwd")).toBeNull();
  });
});

describe("normalizePathForCompare", () => {
  it("keeps drive letters and collapses ..", () => {
    expect(normalizePathForCompare("D:\\projects\\nex\\src\\..\\foo.ts")).toBe(
      "D:/projects/nex/foo.ts",
    );
  });
});

describe("pathFromToolRawInput", () => {
  it("reads common path keys", () => {
    expect(pathFromToolRawInput({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(pathFromToolRawInput({ file_path: "src/b.ts" })).toBe("src/b.ts");
    expect(pathFromToolRawInput({ target_file: "src/c.ts" })).toBe("src/c.ts");
    expect(pathFromToolRawInput({})).toBeNull();
  });
});

describe("openPathToken", () => {
  it("opens the resolved file via fs store", async () => {
    await expect(openPathToken("src/foo.ts")).resolves.toBe(true);
    expect(openFile).toHaveBeenCalledWith(
      "D:\\projects\\nex\\src\\foo.ts",
      { pin: true },
    );
  });
});
