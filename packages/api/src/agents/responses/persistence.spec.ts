import type { StoredResponseMessage, StoredResponseConversation } from './persistence';
import {
  createResponsePersistence,
  persistResponseTurn,
  ResponsePersistenceError,
  sendResponsePersistenceError,
} from './persistence';

const conversationId = 'd91ade18-8688-4b08-88c3-28c250ca12aa';

function fixture() {
  const conversations = new Map<string, StoredResponseConversation>();
  const messages = new Map<string, StoredResponseMessage>();
  const store = {
    async getConvo(userId: string, id: string) {
      const row = conversations.get(id);
      return row?.user === userId ? row : null;
    },
    async getMessage(query: { user: string; messageId: string }) {
      const row = messages.get(query.messageId);
      return row?.user === query.user ? row : null;
    },
    async getMessages(query: { user: string; conversationId: string }) {
      return [...messages.values()].filter(
        (row) => row.user === query.user && row.conversationId === query.conversationId,
      );
    },
    async saveMessage(ctx: { userId: string }, fields: Record<string, unknown>) {
      if (!ctx.userId) throw new Error('User not authenticated');
      const row = {
        ...fields,
        _id: (messages.size + 1).toString(16).padStart(24, '0'),
        messageId: String(fields.messageId),
        conversationId: String(fields.conversationId),
        user: ctx.userId,
      };
      messages.set(String(row.messageId), row);
      return row;
    },
    async saveConvo(
      ctx: { userId: string },
      fields: Record<string, unknown>,
      _options?: { appendMessageIds: string[] },
    ) {
      const row = { ...fields, conversationId: String(fields.conversationId), user: ctx.userId };
      conversations.set(String(row.conversationId), row);
      return row;
    },
  };
  const persistence = createResponsePersistence(store);
  return { conversations, messages, persistence, store };
}

const response = {
  id: 'resp_first',
  model: 'agent_any',
  status: 'completed',
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text: 'Noted.' }],
    },
  ],
};

describe('native response conversation persistence', () => {
  it('stores a linked turn under its authenticated user and returns its native conversation ID', async () => {
    const f = fixture();
    const saveConversation = jest.spyOn(f.store, 'saveConvo');
    await f.persistence.saveTurn({
      context: { userId: 'alice' },
      conversation: { conversationId, endpoint: 'agents', agent_id: 'agent_any' },
      input: [{ role: 'user', content: 'Remember ORCHID-742.' }],
      response,
      parentMessageId: null,
    });
    expect(saveConversation.mock.calls[0][2]).toMatchObject({
      appendMessageIds: ['000000000000000000000001', '000000000000000000000002'],
    });
    const result = await f.persistence.resolve({
      userId: 'alice',
      previousResponseId: 'resp_first',
    });
    expect(result).toMatchObject({
      ok: true,
      conversationId,
      parentMessageId: 'resp_first',
      history: [
        { isCreatedByUser: true, text: 'Remember ORCHID-742.' },
        { messageId: 'resp_first', isCreatedByUser: false, text: 'Noted.' },
      ],
    });
  });

  it('continues a native UI branch without including messages from its sibling branch', async () => {
    const f = fixture();
    f.conversations.set(conversationId, { conversationId, user: 'alice' });
    for (const [id, parent, text] of [
      ['user-a', null, 'Question'],
      ['answer-a', 'user-a', 'Selected answer'],
      ['answer-b', 'user-a', 'Sibling answer'],
    ] as const) {
      f.messages.set(String(id), {
        messageId: id,
        parentMessageId: parent,
        text,
        conversationId,
        user: 'alice',
      });
    }
    const result = await f.persistence.resolve({
      userId: 'alice',
      conversationId,
      parentMessageId: 'answer-a',
    });
    expect(result).toMatchObject({
      ok: true,
      history: [{ text: 'Question' }, { text: 'Selected answer' }],
    });
  });

  it('does not resolve another user’s response or conversation', async () => {
    const f = fixture();
    f.conversations.set(conversationId, { conversationId, user: 'alice' });
    f.messages.set('resp_private', {
      messageId: 'resp_private',
      conversationId,
      user: 'alice',
    });
    expect(
      await f.persistence.resolve({ userId: 'bob', previousResponseId: 'resp_private' }),
    ).toEqual({
      ok: false,
      status: 404,
      code: 'conversation_not_found',
    });
  });

  it('propagates storage failures instead of acknowledging a completed turn', async () => {
    const f = fixture();
    f.store.saveMessage = async () => {
      throw new Error('database offline');
    };
    await expect(
      f.persistence.saveTurn({
        context: { userId: 'alice' },
        conversation: { conversationId, endpoint: 'agents' },
        input: [{ role: 'user', content: 'Hello' }],
        response,
        parentMessageId: null,
      }),
    ).rejects.toMatchObject({ code: 'response_persistence_failed' });
  });
});

describe('response persistence contract', () => {
  it('retrieves one saved response by response ID, preserving tool results and reasoning', async () => {
    const f = fixture();
    await f.persistence.saveTurn({
      context: { userId: 'alice' },
      conversation: { conversationId, agent_id: 'agent_any' },
      input: [{ role: 'user', content: [{ type: 'text', text: 'Read context' }] }],
      parentMessageId: null,
      response: {
        ...response,
        output: [
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Check context' }] },
          { type: 'function_call', call_id: 'read-1', name: 'read_context', arguments: '{}' },
          { type: 'function_call_output', call_id: 'read-1', output: 'Context found' },
          ...response.output,
        ],
      },
    });
    const result = await f.persistence.read('alice', response.id);
    expect(result).toMatchObject({ id: response.id, conversation_id: conversationId, store: true });
    expect(result?.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'Check context' }],
        }),
        expect.objectContaining({ type: 'function_call', call_id: 'read-1' }),
        expect.objectContaining({ type: 'function_call_output', output: 'Context found' }),
        expect.objectContaining({
          type: 'message',
          content: [expect.objectContaining({ text: 'Noted.' })],
        }),
      ]),
    );
    expect(await f.persistence.read('bob', response.id)).toBeNull();
    expect([...f.messages.values()][0].text).toBe('Read context');
  });

  it('propagates legacy non-throwing database failures', async () => {
    const f = fixture();
    const saveConvo = jest.spyOn(f.store, 'saveConvo').mockResolvedValue(undefined as never);
    await expect(
      f.persistence.saveTurn({
        context: { userId: 'alice' },
        conversation: { conversationId },
        input: [],
        response,
        parentMessageId: null,
      }),
    ).rejects.toMatchObject({ code: 'response_persistence_failed' });
    expect(saveConvo).toHaveBeenCalled();
  });

  it('passes the same native retention context to message and conversation writes', async () => {
    const f = fixture();
    const saveMessage = jest.spyOn(f.store, 'saveMessage');
    const saveConvo = jest.spyOn(f.store, 'saveConvo');
    const expiredAt = new Date('2030-01-01T00:00:00Z');
    await persistResponseTurn(f.store, {
      req: {
        user: { id: 'alice' },
        resolvedConversation: { conversationId, isTemporary: true, expiredAt },
      },
      request: { model: 'agent_any', input: 'hello', store: true },
      conversationId,
      parentMessageId: null,
      agent: { id: 'agent_any' },
      inputMessages: [{ role: 'user', content: 'hello' }],
      response,
      title: 'Test',
      codeEnvironmentDecision: { mode: 'without_attached' },
      trace: async () => ({}),
    });
    expect(saveMessage.mock.calls[0][0]).toMatchObject({
      userId: 'alice',
      isTemporary: true,
      expiredAt,
    });
    expect(saveConvo.mock.calls[0][0]).toEqual(saveMessage.mock.calls[0][0]);
  });

  it('saves the matching native model preset without adopting another agent’s preset', async () => {
    const f = fixture();
    const saveConvo = jest.spyOn(f.store, 'saveConvo');
    await persistResponseTurn(f.store, {
      req: {
        user: { id: 'alice' },
        config: {
          modelSpecs: {
            enforce: true,
            prioritize: true,
            list: [
              {
                name: 'architect',
                label: 'Architect',
                preset: { endpoint: 'agents', agent_id: 'agent_other' },
              },
              {
                name: 'the-selected-agent',
                label: 'Selected agent',
                preset: { endpoint: 'agents', agent_id: 'agent_any' },
              },
            ],
          },
        },
        resolvedConversation: { conversationId, spec: 'architect' },
      },
      request: { model: 'agent_any', input: 'hello', store: true },
      conversationId,
      parentMessageId: null,
      agent: { id: 'agent_any' },
      inputMessages: [],
      response,
      title: 'Test',
      codeEnvironmentDecision: { mode: 'without_attached' },
      trace: async () => ({}),
    });
    expect(saveConvo.mock.calls[0][1]).toMatchObject({
      agent_id: 'agent_any',
      spec: 'the-selected-agent',
    });
  });

  it('does not persist a stateless request', async () => {
    const f = fixture();
    const trace = jest.fn();
    await persistResponseTurn(f.store, {
      req: { user: { id: 'alice' } },
      request: { model: 'agent_any', input: 'hello' },
      conversationId,
      parentMessageId: null,
      agent: { id: 'agent_any' },
      inputMessages: [],
      response,
      title: 'Test',
      codeEnvironmentDecision: { mode: 'without_attached' },
      trace,
    });
    expect(trace).not.toHaveBeenCalled();
    expect(f.messages.size).toBe(0);
  });

  it('emits response.failed rather than response.completed on a streaming save failure', () => {
    const chunks: string[] = [];
    const res = { headersSent: true, write: (chunk: string) => chunks.push(chunk), end: jest.fn() };
    expect(
      sendResponsePersistenceError(
        new ResponsePersistenceError(new Error('secret DB diagnostic')),
        res as never,
        { responseId: 'resp_failed', model: 'agent_any', createdAt: 0 },
      ),
    ).toBe(true);
    expect(chunks.join('')).toContain('response.failed');
    expect(chunks.join('')).not.toContain('response.completed');
    expect(chunks.join('')).not.toContain('secret DB diagnostic');
    expect(res.end).toHaveBeenCalled();
  });
});
