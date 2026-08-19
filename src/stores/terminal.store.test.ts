import { describe, expect, it } from "vitest";

import { selectProjectActiveSessionId } from "./terminal.store";

describe("selectProjectActiveSessionId", () => {
  it("returns the remembered session for the current project", () => {
    expect(
      selectProjectActiveSessionId(
        {
          sessions: [
            { id: "term-a", title: "Terminal 1", projectId: "proj-a" },
            { id: "term-b", title: "Terminal 1", projectId: "proj-b" },
          ],
          activeSessionByProject: { "proj-a": "term-a", "proj-b": "term-b" },
        },
        "proj-b",
      ),
    ).toBe("term-b");
  });

  it("falls back to the first session in the project when remembered id is stale", () => {
    expect(
      selectProjectActiveSessionId(
        {
          sessions: [
            { id: "term-a", title: "Terminal 1", projectId: "proj-a" },
            { id: "term-b", title: "Terminal 2", projectId: "proj-a" },
          ],
          activeSessionByProject: { "proj-a": "missing" },
        },
        "proj-a",
      ),
    ).toBe("term-a");
  });

  it("returns null when the project has no sessions", () => {
    expect(
      selectProjectActiveSessionId(
        {
          sessions: [],
          activeSessionByProject: {},
        },
        "proj-a",
      ),
    ).toBeNull();
  });
});
