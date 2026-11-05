/** Operator-owned allowlist applies at execution, regardless of agent or UI entry point. */
export function assertMCPToolAllowed(allowedTools: string[] | undefined, toolName: string): void {
  if (allowedTools != null && !allowedTools.includes(toolName)) {
    throw new Error('mcp_tool_not_allowed');
  }
}

interface ToolPolicyServer {
  source?: string;
  url?: string;
  allowedTools?: string[];
}

/** An alias on the same upstream origin cannot relax an operator-owned restriction. */
export function assertMCPEndpointToolAllowed(
  servers: ToolPolicyServer[],
  target: ToolPolicyServer | undefined,
  toolName: string,
): void {
  assertMCPToolAllowed(target?.allowedTools, toolName);
  if (!target?.url) return;
  const origin = new URL(target.url).origin;
  for (const server of servers) {
    if (
      (server.source === 'yaml' || server.source === 'config') &&
      server.url &&
      new URL(server.url).origin === origin
    ) {
      assertMCPToolAllowed(server.allowedTools, toolName);
    }
  }
}
