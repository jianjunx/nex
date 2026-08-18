/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import FileIcon, {
  fallbackFileIconUrl,
  fallbackIconName,
  fileIconUrl,
  replaceWithFallbackIcon,
} from "./FileIcon";
import {
  defaultFileIcon,
  defaultFolderIcon,
  defaultFolderOpenIcon,
  defaultRootFolderIcon,
  defaultRootFolderOpenIcon,
} from "./iconManifest.generated";

describe("FileIcon fallbacks", () => {
  it("derives fallback icon names for files and folders", () => {
    expect(fallbackIconName()).toBe(defaultFileIcon);
    expect(fallbackIconName({ isFolder: true })).toBe(defaultFolderIcon);
    expect(fallbackIconName({ isFolder: true, isOpen: true })).toBe(defaultFolderOpenIcon);
    expect(fallbackIconName({ isFolder: true, isRoot: true })).toBe(defaultRootFolderIcon);
    expect(fallbackIconName({ isFolder: true, isRoot: true, isOpen: true })).toBe(
      defaultRootFolderOpenIcon,
    );
  });

  it("replaces a missing specific icon URL with the default fallback URL", () => {
    const img = {
      src: fileIconUrl("foo.prw"),
      onerror: (() => {}) as OnErrorEventHandler,
    };

    replaceWithFallbackIcon(img);

    expect(img.src).toBe(fallbackFileIconUrl());
    expect(img.onerror).toBeNull();
  });

  it("react file icons swap to the fallback asset on load error", () => {
    const { container } = render(<FileIcon filename="foo.prw" />);
    const img = container.querySelector("img") as HTMLImageElement;

    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe(fileIconUrl("foo.prw"));

    fireEvent.error(img);

    expect(img.src.endsWith(fallbackFileIconUrl())).toBe(true);
  });
});
