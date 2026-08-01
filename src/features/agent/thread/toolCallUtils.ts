import type { ToolCallEntry } from "./types";

export function isEditTool(entry: ToolCallEntry): boolean {
  return entry.toolKind.toLowerCase() === "edit";
}
