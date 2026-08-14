// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOverComposer, parentDirOf, pointInRect, resolveDirDropTarget } from "./dropTargets";

function rect(x: number, y: number, w: number, h: number): DOMRect {
  return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) } as DOMRect;
}

function el(attrs: Record<string, string>): HTMLElement {
  const div = document.createElement("div");
  for (const [k, v] of Object.entries(attrs)) div.setAttribute(k, v);
  document.body.appendChild(div);
  return div;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  // jsdom does not implement elementFromPoint — provide a stub so spyOn works.
  document.elementFromPoint = vi.fn(() => null);
});

describe("pointInRect", () => {
  it("bounds inclusive", () => {
    const r = rect(10, 20, 100, 50);
    expect(pointInRect({ x: 10, y: 20 }, r)).toBe(true);
    expect(pointInRect({ x: 110, y: 70 }, r)).toBe(true);
    expect(pointInRect({ x: 9, y: 20 }, r)).toBe(false);
    expect(pointInRect({ x: 111, y: 70 }, r)).toBe(false);
  });
});

describe("parentDirOf", () => {
  it("handles forward slashes", () => {
    expect(parentDirOf("/a/b/c.txt")).toBe("/a/b");
  });
  it("handles backslashes (Windows)", () => {
    expect(parentDirOf("C:\\a\\b.txt")).toBe("C:\\a");
  });
  it("returns input when no separator", () => {
    expect(parentDirOf("file.txt")).toBe("file.txt");
  });
});

describe("resolveDirDropTarget", () => {
  it("returns null outside the container rect", () => {
    const container = el({});
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 0, 100, 100));
    expect(resolveDirDropTarget({ x: 500, y: 500 }, container, "ROOT")).toBeNull();
    expect(resolveDirDropTarget({ x: 10, y: 10 }, null, "ROOT")).toBeNull();
  });

  it("hits a directory row via elementFromPoint + closest", () => {
    const container = el({});
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 0, 300, 300));
    const row = el({ "data-dir-path": "/proj/src" });
    const child = document.createElement("span");
    row.appendChild(child);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(child);
    expect(resolveDirDropTarget({ x: 5, y: 5 }, container, "/proj")).toBe("/proj/src");
  });

  it("maps a file row to its parent directory", () => {
    const container = el({});
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 0, 300, 300));
    const row = el({ "data-file-path": "/proj/src/main.rs" });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(row);
    expect(resolveDirDropTarget({ x: 5, y: 5 }, container, "/proj")).toBe("/proj/src");
  });

  it("prefers directory row over nested file row", () => {
    const container = el({});
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 0, 300, 300));
    const dirRow = el({ "data-dir-path": "/proj/src" });
    const fileRow = el({ "data-file-path": "/proj/other.txt" });
    dirRow.appendChild(fileRow);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(fileRow);
    // fileRow is inside dirRow: closest([data-dir-path]) wins
    expect(resolveDirDropTarget({ x: 5, y: 5 }, container, "/proj")).toBe("/proj/src");
  });

  it("falls back to project root on empty area", () => {
    const container = el({});
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 0, 300, 300));
    vi.spyOn(document, "elementFromPoint").mockReturnValue(container);
    expect(resolveDirDropTarget({ x: 200, y: 200 }, container, "/proj")).toBe("/proj");
  });
});

describe("isOverComposer", () => {
  it("false when no dropzone exists", () => {
    expect(isOverComposer({ x: 10, y: 10 })).toBe(false);
  });

  it("true when the point is inside the dropzone", () => {
    const zone = el({ "data-composer-dropzone": "" });
    vi.spyOn(zone, "getBoundingClientRect").mockReturnValue(rect(0, 400, 400, 100));
    expect(isOverComposer({ x: 100, y: 450 })).toBe(true);
    expect(isOverComposer({ x: 100, y: 100 })).toBe(false);
  });
});
