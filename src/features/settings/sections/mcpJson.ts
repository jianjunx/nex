export type ParsedMcpServer = {
  name: string;
  command?: string | null;
  args: string[];
  env: Record<string, string>;
  url?: string | null;
  headers: Record<string, string>;
};

function asStringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function parseOne(name: string, raw: unknown): ParsedMcpServer {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("服务器名称不能为空");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`服务器 “${trimmed}” 配置无效`);
  }
  const o = raw as Record<string, unknown>;
  const command = typeof o.command === "string" && o.command.trim() ? o.command.trim() : null;
  const url = typeof o.url === "string" && o.url.trim() ? o.url.trim() : null;
  if (!command && !url) {
    throw new Error(`服务器 “${trimmed}” 需要 command 或 url`);
  }
  return {
    name: trimmed,
    command,
    args: asStringArray(o.args),
    env: asStringRecord(o.env),
    url,
    headers: asStringRecord(o.headers),
  };
}

/** Parse Claude-compatible `{ "mcpServers": { "<name>": { command | url, ... } } }`. */
export function parseMcpServersJson(text: string): ParsedMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("JSON 无法解析");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON 需为对象");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name === "string" && (obj.command || obj.url)) {
    return [parseOne(obj.name, obj)];
  }
  const servers = obj.mcpServers ?? obj.mcp_servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error('需要 { "mcpServers": { "名称": { "command" 或 "url" } } }');
  }
  const entries = Object.entries(servers as Record<string, unknown>);
  if (entries.length === 0) throw new Error("mcpServers 为空");
  return entries.map(([name, cfg]) => parseOne(name, cfg));
}

export const DEFAULT_MCP_JSON = `{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
`;
