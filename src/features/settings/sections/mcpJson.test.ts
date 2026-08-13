import { describe, expect, it } from "vitest";
import { parseMcpServersJson } from "./mcpJson";

describe("parseMcpServersJson", () => {
  it("parses a Claude-compatible mcpServers object", () => {
    const servers = parseMcpServersJson(`{
      "mcpServers": {
        "fs": { "command": "npx", "args": ["-y", "pkg"] },
        "http": { "url": "http://127.0.0.1:3000/mcp", "headers": { "Authorization": "Bearer x" } }
      }
    }`);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ name: "fs", command: "npx", args: ["-y", "pkg"] });
    expect(servers[1]).toMatchObject({
      name: "http",
      url: "http://127.0.0.1:3000/mcp",
      headers: { Authorization: "Bearer x" },
    });
  });

  it("rejects missing mcpServers and servers without command/url", () => {
    expect(() => parseMcpServersJson("{}" )).toThrow(/mcpServers/);
    expect(() => parseMcpServersJson(`{"mcpServers":{"x":{}}}`)).toThrow(/command 或 url/);
    expect(() => parseMcpServersJson("not json")).toThrow(/无法解析/);
  });

  it("parses a single named server object", () => {
    const servers = parseMcpServersJson(`{
      "name": "fs",
      "command": "node",
      "args": ["server.js"]
    }`);
    expect(servers).toEqual([
      expect.objectContaining({ name: "fs", command: "node", args: ["server.js"] }),
    ]);
  });
});
