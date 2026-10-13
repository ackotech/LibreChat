# LibreChat + OpenChoreo MCP test environment

This guide is for creating a **shared, centrally hosted test deployment** of LibreChat connected to the OpenChoreo Platform MCP. It is not a local laptop setup. It keeps the MCP available to all LibreChat users while each user signs in to Thunder with their own account; the resulting MCP access remains subject to that user's OpenChoreo permissions.

Replace every `<...>` value with the test environment's real value. Do not put API keys, OAuth client secrets, or user tokens in this file or in Git.

## Progress checklist

Mark a box only after the step has been completed and checked in the test environment.

- [ ] Test LibreChat URL and deployment owner agreed.
- [ ] LibreChat deployed centrally with persistent database and storage, TLS, and secrets managed outside Git.
- [ ] Test MCP and Thunder URLs confirmed reachable from LibreChat and user browsers.
- [ ] Thunder OAuth client registration (DCR or pre-registered client) confirmed for the LibreChat callback.
- [ ] Global MCP config loaded and the MCP connects.
- [ ] User-level OAuth tested with a non-admin test account.
- [ ] Read-only agent shared and visible to a non-admin test account.
- [ ] Agent smoke checks completed and evidence/date recorded below.

**Test deployment URL:** `<https://librechat-test.example.com>`  
**LibreChat version/tag:** `<pin the tested LibreChat tag or commit>`  
**MCP URL:** `<https://platform-mcp.<test-domain>/mcp>`  
**Thunder issuer:** `<https://<test-thunder-host>>`  
**Owner / date:** `<name / YYYY-MM-DD>`

## 1. Deploy LibreChat centrally

Use the team's supported test hosting platform (for example, OpenChoreo) and deploy this LibreChat fork at a pinned tag or commit. Do not expose a developer's laptop or use the local Docker Compose override as the shared deployment.

Provide the deployment with:

- A stable HTTPS URL reachable by test users and Thunder.
- Persistent MongoDB and file storage appropriate for the test environment.
- A strong, unique `CREDS_KEY` and `CREDS_IV`, plus a strong `JWT_SECRET` and `JWT_REFRESH_SECRET`, stored in the platform's secret manager.
- The selected model provider and its API key in the platform secret manager. The key is server-side so all users can use the shared agent; never add it to this document or client-side configuration.
- `DOMAIN_SERVER` set to the public HTTPS LibreChat URL. This is used to build the MCP OAuth callback.
- The normal deployment health checks, resource limits, ingress, and logs.

Keep password login enabled if required for the test admin. Configure normal users' login provider separately; LibreChat login and MCP/Thunder authorization are different authentication steps.

## 2. Confirm OAuth registration with the Thunder owner

For the MCP server name below, LibreChat's callback is:

```text
<DOMAIN_SERVER>/api/mcp/acko-dev-platform-mcp/oauth/callback
```

For example, if the test LibreChat URL is `https://librechat-test.example.com`, the callback is `https://librechat-test.example.com/api/mcp/acko-dev-platform-mcp/oauth/callback`.

Ask the Thunder/OpenChoreo team to confirm:

1. The test MCP advertises protected-resource metadata that points to the correct test Thunder issuer.
2. The OAuth authorization-code flow and PKCE S256 are enabled.
3. Dynamic Client Registration is enabled for this LibreChat deployment, **or** the team registers a client for the exact callback above and provides the supported client configuration securely.
4. The registered redirect URI uses HTTPS and exactly matches `DOMAIN_SERVER` plus the callback path.
5. Test user accounts have the required OpenChoreo permissions and scopes (`openid`, `profile`, `email`, plus any MCP-required scopes).

Do not copy the local `localhost:3080` callback into the test identity-provider registration. If Thunder does not allow DCR and requires a confidential pre-registered client, confirm the supported LibreChat static OAuth configuration before configuring it; do not guess the YAML shape.

## 3. Add the global MCP configuration

Mount the configuration into the **central LibreChat API service** as `/app/librechat.yaml` (read-only is recommended), or apply it through the deployment's supported configuration mechanism. Substitute the test MCP and Thunder hostnames. Include both hosts in `allowedDomains`: the MCP host is needed for the server and the Thunder host for OAuth discovery/authorization/token URLs.

```yaml
version: "1.3.17"

mcpSettings:
  # Trust only the test MCP and its test OAuth issuer.
  # Scheme and port pin the entries to HTTPS on 443.
  allowedDomains:
    - https://<test-mcp-host>:443
    - https://<test-thunder-host>:443
  # Private-network exception list for these internal services only.
  # Use host:port entries; do not use wildcards or broad IP ranges.
  allowedAddresses:
    - <test-mcp-host>:443
    - <test-thunder-host>:443

mcpServers:
  acko-dev-platform-mcp:
    type: streamable-http
    url: https://<test-mcp-host>/mcp
    requiresOAuth: true
```

If the test hosts are public and do not resolve to private/reserved addresses, the `allowedAddresses` entries may not be needed. Keep `allowedDomains` restricted to the exact test hosts either way. Restart/redeploy the LibreChat API service after changing YAML; confirm startup logs show the config was loaded without validation errors.

## 4. Create and share the Phase 1 Architect Intake agent

Sign in to the shared test instance as a **LibreChat administrator**. The administrator creates and configures the **Platform Architect Intake** agent once, using the copy-ready settings and full instructions in [PHASE-1-ARCHITECT-INTAKE-AGENT.md](PHASE-1-ARCHITECT-INTAKE-AGENT.md), then shares it with users as `Viewer`. Regular users only discover/select and use the shared agent; they do not create or configure it. This initial agent reads accessible OpenChoreo context, asks focused questions, and returns a proposed 2–3 step plan. It has no Jira/Slack actions, no human notifications, and no infrastructure write tools.

Share this agent with test users as `Viewer`, then verify it appears in the marketplace for a regular user. Do not grant every user permission to publish/share agents globally just to make this single agent available.

Agent sharing shares the agent definition, not an administrator's MCP token. Each user must authenticate the MCP from their own LibreChat account.

## 5. Verify with a non-admin user

Use a separate regular test account, not the admin session:

1. Sign in to the central test LibreChat URL.
2. Open the agent marketplace and confirm `Platform Architect Intake` is visible and can be selected.
3. Open MCP/server settings and choose **Authenticate** for `acko-dev-platform-mcp`.
4. Complete the Thunder login with that test user's own account and approve the requested access.
5. Confirm the MCP status changes to connected for that user.
6. Ask: `I need to add Redis caching to <service>. Help me assess this.` Confirm the agent reads relevant accessible context, asks about the need and constraints, and checks simpler/existing-resource options.
7. After answering its questions, confirm it returns a concise 2–3 step proposal, identifies assumptions and missing evidence, and does not claim to have submitted or executed anything.
8. Repeat with a user who lacks access to that namespace, if available. Confirm the agent does not expose the first user's results or admin credentials.
9. Confirm no mutating tools are enabled on the shared agent.

Record the result here:

| Check | Result / evidence | Date / tester |
| --- | --- | --- |
| Test deployment healthy | Pending | — |
| OAuth login as regular user | Pending | — |
| Agent visible as regular user | Pending | — |
| User-scoped namespace listing | Pending | — |
| Workload/application status | Pending | — |
| No write-capable tools enabled | Pending | — |

## Troubleshooting notes

- **“MCP server domain is not in the allowed domains list”**: check the exact MCP hostname in `mcpSettings.allowedDomains`, then redeploy/restart the API service. OAuth also needs the exact Thunder issuer host in this list.
- **OAuth discovery/redirect failure**: check browser access to Thunder, server egress from LibreChat to the MCP and Thunder endpoints, `DOMAIN_SERVER`, HTTPS certificates, and the exact registered callback URI.
- **Server visible only to admin**: confirm the server is in the centrally mounted YAML and the API service loaded it. Agent sharing is a separate setting from MCP server configuration.
- **“Needs Auth” remains after login**: authenticate while signed in as that same user, then refresh the MCP/agent view. Tokens are per-user and are not inherited from the admin.
- **Tool call fails or returns partial results**: capture the tool name, time, request scope, and sanitized error. Check MCP/Thunder/OpenChoreo service health and the user's OpenChoreo access. A LibreChat deployment cannot resolve an upstream OpenChoreo API outage.
- **Provider rejects too many tools**: reduce the agent's selected tools to the read-only list above; do not expose the MCP's full tool catalog to the model.

## Completion log

Update the checklist and verification table above only after testing the shared deployment. Record infrastructure-specific decisions and fixes here so the next test run is repeatable.

| Date | Step completed / change | Verified by |
| --- | --- | --- |
| — | Guide created; shared test deployment not yet provisioned or verified | — |
