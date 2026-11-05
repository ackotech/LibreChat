import { assertMCPToolAllowed, assertMCPEndpointToolAllowed } from './policy';

describe('operator MCP tool policy', () => {
  it('does not let a saved user-server alias bypass the operator policy', () => {
    expect(() =>
      assertMCPEndpointToolAllowed(
        [{ source: 'yaml', url: 'https://platform.test/mcp', allowedTools: ['list_services'] }],
        { source: 'user', url: 'https://platform.test/mcp/?alias=true' },
        'confirm_action',
      ),
    ).toThrow('mcp_tool_not_allowed');
  });
  it('rejects a write tool even if another agent asks to execute it', () => {
    expect(() =>
      assertMCPToolAllowed(['product_repo__get_service_config'], 'product_repo__confirm_action'),
    ).toThrow('mcp_tool_not_allowed');
  });
  it('treats an empty allowlist as denying all tools', () => {
    expect(() => assertMCPToolAllowed([], 'some_tool')).toThrow('mcp_tool_not_allowed');
  });
  it('permits an explicitly approved tool', () => {
    expect(() => assertMCPToolAllowed(['list_services'], 'list_services')).not.toThrow();
  });
  it('preserves existing deployments that have no operator policy', () => {
    expect(() => assertMCPToolAllowed(undefined, 'existing_tool')).not.toThrow();
  });
});
