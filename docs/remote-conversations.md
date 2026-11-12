# Shared Responses API and UI conversations

`POST /api/agents/v1/responses` can persist turns in the native conversation store. This is generic across saved agents; no Architect ID is embedded in the implementation.

## Client contract

Authenticate with the current user's personal LibreChat Agents API key. The user needs Remote Agents USE and VIEW access to the selected remote agent. This change does not introduce an OAuth login bridge.

Create a durable conversation:

```json
{ "model": "<agent-id>", "input": "Remember ORCHID-742.", "store": true, "stream": false }
```

The response contains `id` (response/message ID) and `conversation_id` (native conversation UUID). Open `<LibreChat origin>/c/<conversation_id>` in the UI as the same user.

Continue using either:

- `previous_response_id`: a saved Responses API ID or native assistant message ID;
- `conversation_id`, optionally with `parent_message_id` to select a specific native branch. Without a parent, the latest stored message is selected.

The legacy use of a native conversation UUID in `previous_response_id` remains accepted. Unknown, conflicting or inaccessible references fail rather than starting a disconnected chat. Child agent threads remain read-only for continuation.

`GET /api/agents/v1/responses/<response-id>` retrieves one stored assistant response. A legacy conversation UUID retrieves its latest assistant turn. Retrieval reconstructs Responses output from native text, reasoning and tool-call content; it is not an exact archive of all original provider metadata.

`store` still defaults to false. Clients requiring UI continuity must set it to true on every turn. A returned conversation ID for a stateless request is not a durable thread.

## Storage and execution

- Reads remain scoped to the authenticated user and the existing tenant middleware.
- History follows parent links, excluding sibling branches. Broken or cyclic history fails closed.
- Message writes use the native user and retention context; conversation references use saved database IDs, distinct from public message IDs.
- Text and structured native content are saved, including tool results present in the Responses output.
- A uniquely matching configured model preset is saved for the selected agent. An existing matching preset is retained. This is needed when the native composer enforces presets; it does not grant agent access or add a preset automatically.
- Streaming closes output items before the save, then emits `response.completed` only after persistence succeeds. A save failure produces `response.failed`; non-streaming failures return HTTP 500 with `response_persistence_failed`.

## Verification

Local smoke test used a disposable USER identity and a private tool-free agent, with a hidden local model preset. It did not connect employee infrastructure credentials or execute infrastructure tools.

1. API stored ORCHID-742; native UI displayed both messages.
2. UI recalled ORCHID-742 and added BLUEBIRD-519.
3. API continued from the native assistant message ID and recalled BLUEBIRD-519 under the same conversation UUID.
4. Reloading the UI displayed all six messages.

Focused tests cover user isolation, selected branches, storage failure reporting, retention, native preset matching, structured tool/reasoning content and streaming completion ordering. The existing Responses controller and SDK client-tool tests also run.

## Remaining integration work

This is transcript persistence, not full UI protocol parity. The client-facing login/MCP bridge, request discovery/linkage, durable question/approval/MCP sign-in continuations, rich attachment parity and Chat Completions persistence remain separate work. Do not infer request membership or approval from chat text or conversation IDs.

Writes are not an atomic multi-document transaction and there is no idempotency key in this change. A storage failure may leave partial message rows; the endpoint reports failure instead of acknowledging a saved turn. Concurrent clients should pass an explicit parent to preserve their selected branch.
