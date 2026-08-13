/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilesChangedCard } from "./FilesChangedCard";

const openPathToken = vi.fn().mockResolvedValue(true);
vi.mock("./pathToken", () => ({
  openPathToken: (...args: unknown[]) => openPathToken(...args),
}));

afterEach(() => {
  cleanup();
  openPathToken.mockClear();
});

describe("FilesChangedCard", () => {
  it("renders file names, counts, and opens a file on row click", () => {
    render(
      <FilesChangedCard
        files={[
          { path: "src/IconBar.tsx", additions: 3, deletions: 3 },
          { path: "src/SettingsDialog.tsx", additions: 2, deletions: 2 },
        ]}
      />,
    );
    expect(screen.getByText("修改了 2 个文件")).toBeTruthy();
    expect(screen.getByText("IconBar.tsx")).toBeTruthy();
    expect(screen.getByText("SettingsDialog.tsx")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText("−3")).toBeTruthy();

    fireEvent.click(screen.getByText("IconBar.tsx"));
    expect(openPathToken).toHaveBeenCalledWith("src/IconBar.tsx");
  });

  it("查看 opens every file then focuses the first", async () => {
    render(
      <FilesChangedCard
        files={[
          { path: "a.ts", additions: 1, deletions: 0 },
          { path: "b.ts", additions: 0, deletions: 1 },
        ]}
      />,
    );
    fireEvent.click(screen.getByText("查看"));
    await vi.waitFor(() => {
      expect(openPathToken).toHaveBeenCalledTimes(3);
    });
    expect(openPathToken.mock.calls.map((c) => c[0])).toEqual(["a.ts", "b.ts", "a.ts"]);
  });
});
