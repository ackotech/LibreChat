import { randomUUID } from 'node:crypto';
import type { TSpecsConfig } from 'librechat-data-provider';
import type { Response as ServerResponse } from 'express';
import type { ConversationWriteContext, TurnConversationRequest } from '~/conversations/save';
import type { ResponseContext, ResponseRequest, OutputItem, Response } from './types';
import type { ConversationCodeEnvironmentDecision } from '~/code/decision';
import type { InternalMessage } from './service';
import { buildResponse, createResponseTracker, emitResponseFailed, writeDone } from './handlers';
import { resolvePersistableCodeEnvironmentDecision } from '~/code/decision';
import { getConversationWriteContext } from '~/conversations/save';
import { sendResponsesErrorResponse } from './service';

export interface StoredResponseMessage {
  messageId: string;
  conversationId: string;
  parentMessageId?: string | null;
  text?: string;
  content?: unknown[];
  isCreatedByUser?: boolean;
  model?: string;
  [key: string]: unknown;
}

export interface StoredResponseConversation {
  conversationId: string;
  subagentThread?: unknown;
  [key: string]: unknown;
}

export interface ResponseStore {
  getConvo(userId: string, conversationId: string): Promise<StoredResponseConversation | null>;
  getMessage(query: { user: string; messageId: string }): Promise<StoredResponseMessage | null>;
  getMessages(query: { user: string; conversationId: string }): Promise<StoredResponseMessage[]>;
  saveMessage(
    context: ConversationWriteContext,
    fields: Record<string, unknown>,
    metadata?: { context: string },
  ): Promise<unknown>;
  saveConvo(
    context: ConversationWriteContext,
    fields: Record<string, unknown>,
    options?: { context: string; appendMessageIds: string[]; initialAgentId?: string },
  ): Promise<unknown>;
}

interface Output {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  content?: readonly { type: string; text?: string; refusal?: string }[];
  summary?: readonly { text: string }[];
}

interface PersistableResponse {
  id: string;
  model: string;
  status: string;
  output: readonly Output[];
}

type Resolution =
  | {
      ok: true;
      conversationId: string;
      conversation: StoredResponseConversation | null;
      parentMessageId: string | null;
      history: StoredResponseMessage[];
    }
  | { ok: false; status: number; code: string };

export class ResponsePersistenceError extends Error {
  readonly code = 'response_persistence_failed';
  readonly status = 500;

  constructor(cause: unknown) {
    super('The conversation could not be saved.', { cause });
  }
}

/** Preserve the native UI content representation, including completed backend tools. */
function outputContent(output: readonly Output[]) {
  const results = new Map(
    output
      .filter((item) => item.type === 'function_call_output')
      .map((item) => [item.call_id, item.output]),
  );
  const content: Record<string, unknown>[] = [];
  for (const item of output) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' || part.type === 'refusal') {
          content.push({ type: 'text', text: part.text ?? part.refusal ?? '' });
        }
      }
    } else if (item.type === 'reasoning') {
      const think = (item.content ?? item.summary ?? [])
        .map((part) => ('text' in part ? (part.text ?? '') : ''))
        .join('');
      if (think) content.push({ type: 'think', think });
    } else if (item.type === 'function_call') {
      content.push({
        type: 'tool_call',
        tool_call: {
          type: 'tool_call',
          id: item.call_id,
          name: item.name,
          args: item.arguments ?? '',
          ...(results.has(item.call_id) && { output: results.get(item.call_id) }),
        },
      });
    }
  }
  return content;
}

type ResolveInput = {
  userId: string;
  previousResponseId?: string;
  conversationId?: string;
  parentMessageId?: string;
};

type SaveTurnInput = {
  context: ConversationWriteContext;
  conversation: { conversationId: string; [key: string]: unknown };
  input: readonly InternalMessage[];
  response: PersistableResponse;
  parentMessageId: string | null;
  traceFields?: Record<string, unknown>;
  tokenCount?: number;
};

interface ResponsePersistence {
  resolve(input: ResolveInput): Promise<Resolution>;
  saveTurn(input: SaveTurnInput): Promise<string>;
  read(userId: string, responseId: string): Promise<Response | null>;
}

/** User-scoped storage shared by the Responses API and native conversation readers. */
export function createResponsePersistence(store: ResponseStore): ResponsePersistence {
  async function resolve(input: ResolveInput): Promise<Resolution> {
    for (const value of [input.previousResponseId, input.conversationId, input.parentMessageId]) {
      if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
        return { ok: false, status: 400, code: 'invalid_conversation_reference' };
      }
    }
    const missing = { ok: false, status: 404, code: 'conversation_not_found' } as const;
    let id = input.conversationId;
    let parent = input.parentMessageId;
    if (input.previousResponseId) {
      const message = await store.getMessage({
        user: input.userId,
        messageId: input.previousResponseId,
      });
      if (message) {
        if (id && id !== message.conversationId) {
          return { ok: false, status: 400, code: 'conversation_mismatch' };
        }
        id = message.conversationId;
        parent ??= message.messageId;
      } else {
        // Compatibility: earlier clients supplied the native conversation UUID here.
        if (id && id !== input.previousResponseId) {
          return { ok: false, status: 400, code: 'conversation_mismatch' };
        }
        id = input.previousResponseId;
      }
    }
    if (!id) {
      if (parent) return { ok: false, status: 400, code: 'conversation_required' };
      return {
        ok: true,
        conversationId: randomUUID(),
        conversation: null,
        parentMessageId: null,
        history: [],
      };
    }
    const conversation = await store.getConvo(input.userId, id);
    if (!conversation) return missing;
    if (conversation.subagentThread != null) {
      return { ok: false, status: 409, code: 'conversation_read_only' };
    }
    const messages = await store.getMessages({ user: input.userId, conversationId: id });
    const byId = new Map(messages.map((message) => [message.messageId, message]));
    parent ??= messages[messages.length - 1]?.messageId;
    if (parent && !byId.has(parent)) return missing;
    const history: StoredResponseMessage[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = parent;
    while (cursor) {
      const message = byId.get(cursor);
      if (!message || seen.has(cursor)) {
        return { ok: false, status: 409, code: 'conversation_history_invalid' };
      }
      seen.add(cursor);
      history.push(message);
      cursor = message.parentMessageId ?? undefined;
      // Native root messages can use this sentinel rather than null.
      if (cursor === '00000000-0000-0000-0000-000000000000') break;
    }
    return {
      ok: true,
      conversationId: id,
      conversation,
      parentMessageId: parent ?? null,
      history: history.reverse(),
    };
  }

  async function saveTurn(input: SaveTurnInput): Promise<string> {
    try {
      let parent = input.parentMessageId;
      const ids: string[] = [];
      for (const message of input.input) {
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        const messageId = randomUUID();
        const content =
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content;
        const text = Array.isArray(content)
          ? content
              .filter((part) => part.type === 'text')
              .map((part) => ('text' in part ? (part.text ?? '') : ''))
              .join('')
          : '';
        const saved = await store.saveMessage(
          input.context,
          {
            messageId,
            conversationId: input.conversation.conversationId,
            parentMessageId: parent,
            isCreatedByUser: message.role === 'user',
            text,
            content,
            sender: message.role === 'user' ? 'User' : 'Agent',
            endpoint: 'agents',
            model: input.response.model,
          },
          { context: 'Responses API - save input' },
        );
        assertSaved(saved, 'messageId', messageId);
        ids.push(messageReference(saved));
        parent = messageId;
      }
      const content = outputContent(input.response.output);
      const text = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      const savedResponse = await store.saveMessage(
        input.context,
        {
          ...input.traceFields,
          messageId: input.response.id,
          conversationId: input.conversation.conversationId,
          parentMessageId: parent,
          isCreatedByUser: false,
          content,
          text,
          sender: 'Agent',
          endpoint: 'agents',
          model: input.response.model,
          finish_reason: input.response.status === 'completed' ? 'stop' : input.response.status,
          tokenCount: input.tokenCount,
        },
        { context: 'Responses API - save assistant response' },
      );
      assertSaved(savedResponse, 'messageId', input.response.id);
      ids.push(messageReference(savedResponse));
      const savedConversation = await store.saveConvo(input.context, input.conversation, {
        context: 'Responses API - save conversation',
        appendMessageIds: ids,
        ...(typeof input.conversation.agent_id === 'string' && {
          initialAgentId: input.conversation.agent_id,
        }),
      });
      assertSaved(savedConversation, 'conversationId', input.conversation.conversationId);
      return input.conversation.conversationId;
    } catch (cause) {
      throw new ResponsePersistenceError(cause);
    }
  }

  async function read(userId: string, responseId: string): Promise<Response | null> {
    let message = await store.getMessage({ user: userId, messageId: responseId });
    const conversation = await store.getConvo(userId, message?.conversationId ?? responseId);
    if (!conversation) return null;
    if (!message) {
      // Legacy clients retrieve the latest assistant turn by native conversation UUID.
      const messages = await store.getMessages({
        user: userId,
        conversationId: conversation.conversationId,
      });
      message = [...messages].reverse().find((entry) => !entry.isCreatedByUser) ?? null;
    }
    if (!message || message.isCreatedByUser) return null;
    const tracker = createResponseTracker();
    tracker.items = storedOutput(message);
    tracker.usage.outputTokens = typeof message.tokenCount === 'number' ? message.tokenCount : 0;
    let timestamp: string | number = Date.now();
    if (message.createdAt instanceof Date) timestamp = message.createdAt.getTime();
    else if (typeof message.createdAt === 'string') timestamp = message.createdAt;
    return buildResponse(
      {
        responseId: message.messageId,
        model: String(conversation.agent_id ?? message.model ?? 'unknown'),
        createdAt: Math.floor(new Date(timestamp).getTime() / 1000),
        conversationId: conversation.conversationId,
        store: true,
      },
      tracker,
      'completed',
    );
  }

  return { resolve, saveTurn, read };
}

function storedOutput(message: StoredResponseMessage): OutputItem[] {
  const output: OutputItem[] = [];
  const parts = message.content ?? [{ type: 'text', text: message.text ?? '' }];
  for (const raw of parts) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as {
      type?: string;
      text?: string;
      think?: string;
      tool_call?: { id: string; name: string; args: string | object; output?: string };
    };
    if (part.type === 'text' && typeof part.text === 'string') {
      output.push({
        type: 'message',
        id: message.messageId,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: part.text, annotations: [], logprobs: [] }],
      });
    } else if (part.type === 'think' && typeof part.think === 'string') {
      output.push({
        type: 'reasoning',
        id: `${message.messageId}_reasoning_${output.length}`,
        status: 'completed',
        content: [{ type: 'reasoning_text', text: part.think }],
        summary: [],
      });
    } else if (part.type === 'tool_call' && part.tool_call) {
      const call = part.tool_call;
      output.push({
        type: 'function_call',
        id: `${message.messageId}_call_${output.length}`,
        status: 'completed',
        call_id: call.id,
        name: call.name,
        arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
      });
      if (call.output !== undefined)
        output.push({
          type: 'function_call_output',
          id: `${message.messageId}_result_${output.length}`,
          status: 'completed',
          call_id: call.id,
          output: call.output,
        });
    }
  }
  return output;
}

/** Keep model-bound provenance when loading a selected native branch. */
export function responseHistory(messages: StoredResponseMessage[]): Array<{
  role: string;
  content: unknown[] | string;
  messageId: string;
  isCreatedByUser: boolean;
  text?: string;
  isUserSubmitted?: boolean;
  userSubmittedPaths?: unknown[];
  userSubmittedMessageFieldPaths?: unknown[];
}> {
  return messages.map((message) => ({
    role: message.isCreatedByUser ? 'user' : 'assistant',
    content: Array.isArray(message.content) ? message.content : (message.text ?? ''),
    messageId: message.messageId,
    isCreatedByUser: message.isCreatedByUser === true,
    ...(message.text !== undefined && { text: message.text }),
    ...(typeof message.isUserSubmitted === 'boolean' && {
      isUserSubmitted: message.isUserSubmitted,
    }),
    ...(Array.isArray(message.userSubmittedPaths) && {
      userSubmittedPaths: message.userSubmittedPaths,
    }),
    ...(Array.isArray(message.userSubmittedMessageFieldPaths) && {
      userSubmittedMessageFieldPaths: message.userSubmittedMessageFieldPaths,
    }),
  }));
}

/** Translate expected admission failures without exposing storage diagnostics. */
export async function admitResponseConversation(
  store: ResponseStore,
  req: { user: { id: string } },
  res: ServerResponse,
  request: ResponseRequest,
): Promise<Extract<Resolution, { ok: true }> | null> {
  let result: Resolution;
  try {
    result = await createResponsePersistence(store).resolve({
      userId: req.user.id,
      previousResponseId: request.previous_response_id,
      conversationId: request.conversation_id,
      parentMessageId: request.parent_message_id,
    });
  } catch {
    sendResponsesErrorResponse(
      res,
      500,
      'The conversation could not be loaded.',
      'server_error',
      'conversation_load_failed',
    );
    return null;
  }
  if (result.ok) return result;
  sendResponsesErrorResponse(
    res,
    result.status,
    'Conversation cannot be continued.',
    result.status === 404 ? 'not_found' : 'invalid_request',
    result.code,
  );
  return null;
}

/** Storage errors must not be followed by a successful completion event. */
export function sendResponsePersistenceError(
  error: unknown,
  res: ServerResponse,
  context: ResponseContext,
): boolean {
  if (!(error instanceof ResponsePersistenceError)) return false;
  const safe = { type: 'server_error', code: error.code, message: error.message };
  if (res.headersSent) {
    emitResponseFailed({ res, context, tracker: createResponseTracker() }, safe);
    writeDone(res);
    res.end();
  } else {
    sendResponsesErrorResponse(res, error.status, safe.message, safe.type, safe.code);
  }
  return true;
}

/** Persist before acknowledging completion, using the native retention and agent metadata. */
export async function persistResponseTurn(
  store: ResponseStore,
  params: {
    req: TurnConversationRequest & { config?: { modelSpecs?: TSpecsConfig } };
    request: ResponseRequest;
    conversationId: string;
    parentMessageId: string | null;
    agent: { id: string; model?: string };
    inputMessages: readonly InternalMessage[];
    response: PersistableResponse;
    title: string | null;
    codeEnvironmentDecision: ConversationCodeEnvironmentDecision;
    trace: () => Promise<Record<string, unknown>>;
    tokenCount?: number;
  },
): Promise<void> {
  if (params.request.store !== true) return;
  await createResponsePersistence(store).saveTurn({
    context: getConversationWriteContext(params.req),
    conversation: {
      conversationId: params.conversationId,
      endpoint: 'agents',
      agent_id: params.agent.id,
      model: params.agent.model,
      ...responseModelSpec(
        params.agent.id,
        params.req.config?.modelSpecs,
        params.req.resolvedConversation?.spec,
      ),
      ...resolvePersistableCodeEnvironmentDecision({
        conversationId: params.conversationId,
        decision: params.codeEnvironmentDecision,
        conversation: {
          conversationId: params.req.resolvedConversation?.conversationId ?? null,
          codeEnvironmentMode: params.req.resolvedConversation?.codeEnvironmentMode,
          codeWorkspaces: params.req.resolvedConversation?.codeWorkspaces,
        },
      }),
      ...(params.title != null && {
        title: params.req.resolvedConversation?.title ?? params.title,
      }),
    },
    parentMessageId: params.parentMessageId,
    input: params.inputMessages,
    response: params.response,
    traceFields: await params.trace(),
    tokenCount: params.tokenCount,
  });
}

function assertSaved(value: unknown, field: string, expected: string) {
  if (
    value == null ||
    typeof value !== 'object' ||
    !(field in value) ||
    Reflect.get(value, field) !== expected
  ) {
    throw new Error('Conversation storage did not acknowledge the write.');
  }
}

/** saveConvo appends database references, distinct from public message/response IDs. */
function messageReference(saved: unknown): string {
  const id = saved != null && typeof saved === 'object' ? Reflect.get(saved, '_id') : undefined;
  const reference = id == null ? '' : String(id);
  if (!reference || reference === '[object Object]')
    throw new Error('Saved message reference is missing.');
  return reference;
}

/** The native composer must retain the matching configured agent preset when presets are enforced. */
function responseModelSpec(
  agentId: string,
  config: TSpecsConfig | undefined,
  existing: string | null | undefined,
): { spec?: string } {
  const matches =
    config?.list?.filter(
      (spec) => spec.preset.endpoint === 'agents' && spec.preset.agent_id === agentId,
    ) ?? [];
  const selected =
    matches.find((spec) => spec.name === existing) ??
    (matches.length === 1 ? matches[0] : undefined);
  return selected ? { spec: selected.name } : {};
}
