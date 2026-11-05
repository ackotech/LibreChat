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
  const governed = servers.filter(
    (server) =>
      (server.source === 'yaml' || server.source === 'config') &&
      server.allowedTools != null &&
      server.url &&
      new URL(server.url).origin === origin,
  );
  if (governed.length) {
    // Multiple operator endpoints on one service may expose disjoint catalogs.
    // An alias gets only their explicitly approved union, never arbitrary tools.
    assertMCPToolAllowed(
      governed.flatMap((server) => server.allowedTools ?? []),
      toolName,
    );
  }
}
