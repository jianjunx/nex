/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ComposerOptionMenu } from "./ComposerOptionMenu";
import { ComposerGroupedOptionMenu } from "./ComposerGroupedOptionMenu";

const options = [
  { id: "old", name: "Old model", group: "Models" },
  { id: "new", name: "New model", group: "Models" },
];
afterEach(cleanup);

for (const Menu of [ComposerOptionMenu, ComposerGroupedOptionMenu]) {
  describe(Menu.name, () => {
    it("clears progress after rejection and allows retry", async () => {
      const onSelect = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
      render(<Menu ariaLabel="Model" value="old" options={options} onSelect={onSelect} />);
      fireEvent.keyDown(screen.getByRole("button", { name: "Model" }), { key: "ArrowDown" });
      const row = await screen.findByRole("menuitem", { name: "New model" });
      fireEvent.click(row);
      await waitFor(() => expect(row.getAttribute("aria-busy")).toBe("false"));
      expect(row.querySelector(".animate-spin")).toBeNull();
      fireEvent.click(row);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(onSelect).toHaveBeenCalledTimes(2);
    });

    it("keeps the pending row visible, blocks duplicate selection, and closes when done", async () => {
      let finish!: () => void;
      const onSelect = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      render(<Menu ariaLabel="Model" value="old" options={options} onSelect={onSelect} />);
      fireEvent.keyDown(screen.getByRole("button", { name: "Model" }), { key: "ArrowDown" });
      const row = await screen.findByRole("menuitem", { name: "New model" });
      fireEvent.click(row);
      expect(row.getAttribute("aria-busy")).toBe("true");
      expect(row.querySelector(".animate-spin")).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Old model" }).getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(row);
      expect(onSelect).toHaveBeenCalledTimes(1);
      await act(async () => finish());
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(screen.getByRole("button", { name: "Model" }).querySelector(".animate-spin")).toBeNull();
    });
  });
}
