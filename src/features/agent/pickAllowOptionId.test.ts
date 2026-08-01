import { describe, expect, it } from "vitest";
import { pickAllowOptionId } from "./pickAllowOptionId";

describe("pickAllowOptionId", () => {
  it("prefers allow_always over allow_once by kind", () => {
    expect(
      pickAllowOptionId([
        { optionId: "once", label: "Allow once", kind: "allow_once" },
        { optionId: "always", label: "Allow always", kind: "allow_always" },
      ]),
    ).toBe("always");
  });

  it("falls back to allow_once when no always", () => {
    expect(
      pickAllowOptionId([
        { optionId: "reject", label: "Reject", kind: "reject_once" },
        { optionId: "once", label: "Allow", kind: "allow_once" },
      ]),
    ).toBe("once");
  });

  it("uses label heuristics when kind is missing", () => {
    expect(
      pickAllowOptionId([
        { optionId: "r1", label: "Reject" },
        { optionId: "a1", label: "Allow" },
      ]),
    ).toBe("a1");
  });

  it("returns null when only reject options exist", () => {
    expect(
      pickAllowOptionId([
        { optionId: "r1", label: "Deny", kind: "reject_once" },
        { optionId: "r2", label: "Reject always", kind: "reject_always" },
      ]),
    ).toBeNull();
  });
});
