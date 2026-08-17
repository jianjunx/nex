import { describe, expect, it } from "vitest";
import { comboToCanonical } from "./types";
import { getCommand, listCommands } from "./registry";
import { useUiStore } from "../stores/ui.store";

describe("command registry", () => {
  it("has unique ids", () => {
    const ids = listCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every command exposes a title and category and a runnable fn", () => {
    for (const c of listCommands()) {
      expect(c.title.trim().length).toBeGreaterThan(0);
      expect(c.category.trim().length).toBeGreaterThan(0);
      expect(typeof c.run).toBe("function");
    }
  });

  it("seeds the core VSCode-style defaults", () => {
    const byId = (id: string) => comboToCanonical(getCommand(id)?.defaultKey ?? null);
    expect(byId("editor.save")).toBe("primary+keys");
    expect(byId("editor.formatDocument")).toBe("alt+shift+keyf");
    expect(byId("view.toggleSidebar")).toBe("primary+keyb");
    expect(byId("search.focus")).toBe("primary+shift+keyf");
    expect(byId("scm.focus")).toBe("primary+shift+keyg");
    expect(byId("terminal.toggle")).toBe("ctrl+`");
    expect(byId("workbench.closeActiveTab")).toBe("primary+keyw");
    expect(byId("view.openSettings")).toBe("primary+,");
    expect(byId("workbench.newConversation")).toBe("primary+shift+keyn");
    expect(byId("scm.commit")).toBe("primary+enter");
    expect(byId("files.rename")).toBe("f2");
  });

  it("single-combo defaults are unique across commands (no accidental clash)", () => {
    const seen = new Map<string, string>();
    for (const c of listCommands()) {
      const k = comboToCanonical(c.defaultKey);
      if (!k) continue;
      // when-scoped duplicates are allowed; the seed set has none, so assert strict uniqueness.
      expect(seen.has(k), `combo ${k} duplicated by ${c.id} and ${seen.get(k)}`).toBe(false);
      seen.set(k, c.id);
    }
  });

  it("workbench.newConversation toggles the new-conversation dropdown flag", () => {
    useUiStore.setState({ newConversationOpen: false });
    getCommand("workbench.newConversation")!.run();
    expect(useUiStore.getState().newConversationOpen).toBe(true);
    getCommand("workbench.newConversation")!.run();
    expect(useUiStore.getState().newConversationOpen).toBe(false);
  });
});
