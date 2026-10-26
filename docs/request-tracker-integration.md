# Request tracker integration

The Developer Productivity Control Plane records request metadata and participant-to-chat links.
LibreChat remains responsible for login, chat transcripts, and shared-link permissions. The browser
uses authenticated LibreChat API routes; the control-plane token stays between backend services.

## Local configuration

1. Start the control-plane service from the sibling `developer-productivity-control-plane` repository
   with `DATABASE_URL` pointing to PostgreSQL and a strong `CONTROL_PLANE_TOKEN`.
2. Give the LibreChat API process the same `CONTROL_PLANE_TOKEN`.
3. Add the following deployment config to `librechat.yaml`, setting `baseUrl` to an address reachable
   from the LibreChat API container or process:

   ```yaml
   requestTracker:
     enabled: true
     baseUrl: http://host.docker.internal:8080
     deploymentId: local
   ```

4. Make sure the `Platform Architect Intake` agent includes `request_admin_approval`,
   `record_request_decision`, `message_request_participant`, and `get_request_context`. Sync the agent
   definition using the existing `npm run sync:agent:platform-architect` script.
5. Restart the LibreChat API and Go service after setting the config and environment.

## Behavior

- Invoking the Architect's request workflow creates one stable request ID for the requester chat.
- Additional participants reuse one chat each per request. The request service rejects a second chat
  for the same participant.
- Participant chat IDs, roles, and read-only share links are mirrored to the control plane. Message
  bodies remain in LibreChat.
- Request IDs appear in linked chat headers and open `/requests/:requestId`. `/requests` lists only
  requests in which the signed-in user participates; pasting an ID still passes through the same
  participant check.
- An explicit approver decision is stored with conditions and optional expiry, then relayed to the
  requester in the original chat. Approval does not provision infrastructure.
- A missing or unavailable tracker is shown as a generic internal service issue. The raw control
  plane error and token are never sent to the browser or shown as chat text.

## Deployment notes

Deploy one control-plane service alongside LibreChat and point it at a durable PostgreSQL database. Use
the same token only as a secret in the two backend workloads. Do not expose `/v1` directly to browsers
or public ingress. Set a distinct `deploymentId` for local, test, and production so request listings
do not mix deployment data. The service creates its normalized tables and indexes at startup.

The request page opens cross-user conversations only through LibreChat read-only share URLs. Those
URLs remain subject to LibreChat ACL checks and are not bearer credentials for the Go service.
