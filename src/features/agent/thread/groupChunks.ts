import type { AssistantChunk } from "./types";

/** 合并相邻同类型 chunk,减少 Markdown 渲染块数量。返回新对象,不改输入。 */
export function groupChunks(chunks: AssistantChunk[]): AssistantChunk[] {
  const out: AssistantChunk[] = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && last.type === c.type) last.text += c.text;
    else out.push({ ...c });
  }
  return out;
}
