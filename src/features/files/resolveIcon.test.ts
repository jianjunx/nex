import { describe, expect, it } from "vitest";
import { resolveIcon } from "./resolveIcon";
import {
  extMap,
  compoundExtMap,
  fileNameMap,
  folderNameMap,
  defaultFileIcon,
  defaultFolderIcon,
  defaultFolderOpenIcon,
  defaultRootFolderIcon,
  defaultRootFolderOpenIcon,
} from "./iconManifest.generated";

describe("resolveIcon files", () => {
  it("resolves by extension", () => {
    expect(resolveIcon("App.tsx")).toBe(extMap["tsx"]);
    expect(resolveIcon("main.rs")).toBe(extMap["rs"]);
  });

  it("prefers exact filename over extension", () => {
    expect(fileNameMap["package.json"]).toBeDefined();
    expect(resolveIcon("package.json")).toBe(fileNameMap["package.json"]);
    expect(resolveIcon("package.json")).not.toBe(extMap["json"]);
  });

  it("is case-insensitive", () => {
    expect(resolveIcon("README.MD")).toBe(resolveIcon("readme.md"));
    expect(resolveIcon("APP.TSX")).toBe(resolveIcon("app.tsx"));
  });

  it("prefers longest compound extension", () => {
    expect(compoundExtMap["schema.json"]).toBeDefined();
    expect(resolveIcon("api.schema.json")).toBe(compoundExtMap["schema.json"]);
    expect(resolveIcon("api.schema.json")).not.toBe(extMap["json"]);
  });

  it("falls back to the default file icon for unknown extensions", () => {
    expect(resolveIcon("blob.xyzzy")).toBe(defaultFileIcon);
    expect(resolveIcon("noextension")).toBe(defaultFileIcon);
    expect(resolveIcon("")).toBe(defaultFileIcon);
  });

  it("never returns an empty icon name", () => {
    for (const name of ["", ".", ".hidden", "a.", "a.b.c.d"]) {
      expect(resolveIcon(name).length).toBeGreaterThan(0);
    }
  });
});

describe("resolveIcon folders", () => {
  it("resolves mapped folder names", () => {
    expect(folderNameMap["src"]).toBeDefined();
    expect(resolveIcon("src", { isFolder: true })).toBe(folderNameMap["src"]);
  });

  it("derives the open variant with a -open suffix", () => {
    expect(resolveIcon("src", { isFolder: true, isOpen: true })).toBe(
      folderNameMap["src"] + "-open",
    );
  });

  it("is case-insensitive for folder names", () => {
    expect(resolveIcon("SRC", { isFolder: true })).toBe(resolveIcon("src", { isFolder: true }));
  });

  it("falls back to default folder icons", () => {
    expect(resolveIcon("mystery-dir", { isFolder: true })).toBe(defaultFolderIcon);
    expect(resolveIcon("mystery-dir", { isFolder: true, isOpen: true })).toBe(
      defaultFolderOpenIcon,
    );
    expect(resolveIcon("", { isFolder: true })).toBe(defaultFolderIcon);
  });

  it("uses dedicated root folder icons", () => {
    expect(resolveIcon("anything", { isFolder: true, isRoot: true })).toBe(defaultRootFolderIcon);
    expect(resolveIcon("anything", { isFolder: true, isRoot: true, isOpen: true })).toBe(
      defaultRootFolderOpenIcon,
    );
  });
});
