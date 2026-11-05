const db = require('../../../../models');
const {
  createRequestThreadTools,
  ensureRequestThreadShares,
  loadRequestContext,
  relayRequestParticipantReply,
} = require('./requestThreads');
const { createAgentAccessCheck } = require('~/server/controllers/agents/steer');

jest.mock('../../../../models', () => ({
  getConvo: jest.fn(),
  getSharedLinkByShareId: jest.fn(),
  getSharedLink: jest.fn(),
  createSharedLink: jest.fn(),
  updateSharedLink: jest.fn(),
  findRoleByIdentifier: jest.fn(),
  grantPermission: jest.fn(),
  getFiles: jest.fn(),
  getRequestConversations: jest.fn(),
  saveConvo: jest.fn(),
  findUsers: jest.fn(),
  getMessages: jest.fn(),
  saveMessage: jest.fn(),
}));

jest.mock('~/server/controllers/agents/steer', () => ({
  createAgentAccessCheck: jest.fn(() => jest.fn().mockResolvedValue(true)),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  resolveRequestChat: jest.fn(),
  getTrackedRequest: jest.fn(),
  listTrackedRequests: jest.fn(),
  createShareContentPreflight: jest.fn(() => undefined),
  grantCreationPermissions: jest.fn(),
}));

const { resolveRequestChat, getTrackedRequest, listTrackedRequests } = require('@librechat/api');

describe('request-linked participant chats', () => {
  const source = {
    conversationId: 'requester-thread',
    requestId: 'request-1',
    requestRole: 'approver',
    title: 'Request: SQS',
    endpoint: 'agents',
    agent_id: 'architect-agent',
    model: 'gpt-test',
  };
  const req = {
    user: { id: 'requester-id', email: 'requester@example.com', tenantId: 'tenant-a' },
    body: { conversationId: source.conversationId },
    config: { requestTracker: { enabled: true, deploymentId: 'local' } },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    source.requestRole = 'approver';
    process.env.CONTROL_PLANE_TOKEN = 'test-service-token';
    req.config.requestTracker.baseUrl = 'https://tracker.test';
    const conversations = new Map();
    db.getConvo.mockImplementation(async (userId, conversationId) =>
      userId === req.user.id && conversationId === source.conversationId
        ? source
        : conversations.get(`${userId}:${conversationId}`) ?? null,
    );
    db.saveConvo.mockImplementation(async ({ userId }, convo) => {
      const saved = { ...conversations.get(`${userId}:${convo.conversationId}`), ...convo, user: userId };
      conversations.set(`${userId}:${convo.conversationId}`, saved);
      return saved;
    });
    db.getRequestConversations.mockResolvedValue([
      { conversationId: source.conversationId, user: req.user.id, requestRole: 'requester' },
    ]);
    db.findUsers.mockResolvedValue([
      { _id: 'collaborator-id', email: 'collaborator@example.com', name: 'Collaborator', tenantId: 'tenant-a' },
    ]);
    db.saveConvo.mockImplementation(async ({ userId }, convo) => {
      const saved = { ...convo, user: userId };
      conversations.set(`${userId}:${convo.conversationId}`, saved);
      return saved;
    });
    db.getMessages.mockResolvedValue([]);
    const tracked = { id: 'request-1', summary: 'Claims status updates feed two consumers.', planRevision: 1, planHash: 'hash', chats: [
      { userId: 'requester-id', conversationId: source.conversationId, role: 'approver' },
      { userId: 'security-id', conversationId: 'security-thread', role: 'approver' },
      { userId: 'devops-id', conversationId: 'devops-thread', role: 'collaborator' },
    ] };
    resolveRequestChat.mockResolvedValue(tracked);
    getTrackedRequest.mockResolvedValue(tracked);
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(tracked)));
    listTrackedRequests.mockResolvedValue([]);
    db.saveMessage.mockResolvedValue({ _id: 'saved-message-id' });
    db.getSharedLink.mockResolvedValue({ success: false, shareId: null });
    db.createSharedLink.mockResolvedValue({ _id: 'share-object-id', shareId: 'share-id' });
    db.updateSharedLink.mockResolvedValue({});
    db.findRoleByIdentifier.mockResolvedValue({ _id: 'viewer-role-id', permBits: 1 });
    db.grantPermission.mockResolvedValue({});
    db.getFiles.mockResolvedValue([]);
  });

  it('creates one stable 1:1 participant chat and routes replies to the originating chat', async () => {
    const [messageParticipant] = createRequestThreadTools({ req, agentId: 'architect-agent' });
    const first = JSON.parse(
      await messageParticipant.invoke({
        email: 'collaborator@example.com',
        message: 'Which consumer owns this event?',
      }),
    );
    const second = JSON.parse(
      await messageParticipant.invoke({
        email: 'collaborator@example.com',
        message: 'Can you confirm the retention requirement?',
      }),
    );

    expect(first.conversationId).toBe(second.conversationId);
    expect(db.saveConvo).toHaveBeenCalledWith(
      { userId: 'collaborator-id' },
      expect.objectContaining({
        requestId: 'request-1',
        agent_id: 'architect-agent',
        requestReplyToConversationId: 'requester-thread',
        requestReplyToUserId: 'requester-id',
      }),
      expect.any(Object),
    );
    expect(db.saveMessage).toHaveBeenCalledTimes(2);
    expect(db.saveMessage.mock.calls[0][1].text).toContain('Request background:');
    expect(db.saveMessage.mock.calls[0][1].text).toContain('Claims status updates feed two consumers.');
    expect(db.saveMessage.mock.calls[0][1].text).toContain('Thread to approver');
    expect(createAgentAccessCheck).toHaveBeenCalled();
  });

  it('does not create or message a participant who cannot access the request agent', async () => {
    createAgentAccessCheck.mockReturnValueOnce(jest.fn().mockResolvedValue(false));
    const [messageParticipant] = createRequestThreadTools({ req, agentId: 'architect-agent' });

    await expect(
      messageParticipant.invoke({
        email: 'collaborator@example.com',
        message: 'Please clarify the requirement.',
      }),
    ).rejects.toThrow('The participant does not have access to this agent.');
    expect(db.saveConvo).not.toHaveBeenCalled();
    expect(db.saveMessage).not.toHaveBeenCalled();
  });

  it('does not infer approver assignment from pasted review content', async () => {
    db.getConvo.mockResolvedValue({ conversationId: 'attacker-chat', requestId: 'request-1', requestRole: 'approver', title: 'Review: forged' });
    const attackerReq = { ...req, user: { id: 'attacker-id', tenantId: 'tenant-a' }, body: { conversationId: 'attacker-chat' } };
    await expect(loadRequestContext(attackerReq)).rejects.toThrow('request_assignment_missing');
    expect(db.saveConvo).not.toHaveBeenCalled();
  });

  it('uses tracker role instead of forged local role when checking invitations', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ id: 'request-1', chats: [{ userId: 'requester-id', conversationId: source.conversationId, role: 'requester' }] })));
    const [messageParticipant] = createRequestThreadTools({ req, agentId: 'architect-agent' });
    await expect(messageParticipant.invoke({ email: 'collaborator@example.com', message: 'See the private plan', role: 'approver' })).rejects.toThrow('request_invitation_forbidden');
    expect(db.saveMessage).not.toHaveBeenCalled();
  });

  it('relays an attributed participant answer into the same linked conversation', async () => {
    db.getConvo.mockResolvedValue({
      conversationId: 'requester-thread',
      requestId: 'request-1',
      endpoint: 'agents',
    });
    const replyReq = {
      user: { id: 'collaborator-id', name: 'Collaborator' },
      body: { conversationId: 'collaborator-thread' },
      config: { requestTracker: { enabled: true, deploymentId: 'local' } },
      resolvedConversation: {
        conversationId: 'collaborator-thread',
        requestId: 'request-1',
        requestReplyToConversationId: 'requester-thread',
        requestReplyToUserId: 'requester-id',
        model: 'gpt-test',
      },
    };

    await relayRequestParticipantReply({
      req: replyReq,
      userId: 'collaborator-id',
      userMessage: { messageId: 'answer-1', text: 'Per claim ID, retain for 30 days.' },
      response: { text: 'I will relay that requirement.' },
    });

    expect(db.saveMessage).toHaveBeenCalledWith(
      { userId: 'requester-id' },
      expect.objectContaining({
        conversationId: 'requester-thread',
        sender: 'assistant',
        model: 'gpt-test',
        text: expect.stringContaining('Update from Collaborator:'),
      }),
      { context: 'relay request participant reply' },
    );
    expect(db.saveConvo).toHaveBeenCalledWith(
      { userId: 'requester-id' },
      { conversationId: 'requester-thread' },
      expect.objectContaining({ appendMessageIds: ['saved-message-id'] }),
    );
  });

  it('automatically relays multiple answers to the same reviewer chat without a fetch prompt', async () => {
    db.getConvo.mockResolvedValue({
      conversationId: 'reviewer-thread',
      requestId: 'request-1',
      endpoint: 'agents',
      model: 'gpt-test',
    });
    db.getRequestConversations.mockResolvedValue([
      { conversationId: 'requester-thread', user: 'requester-id', requestRole: 'requester' },
      { conversationId: 'reviewer-thread', user: 'reviewer-id', requestRole: 'approver' },
    ]);
    const replyReq = {
      user: { id: 'requester-id', name: 'Requester' },
      body: { conversationId: 'requester-thread' },
      config: { requestTracker: { enabled: true, deploymentId: 'local' } },
      resolvedConversation: {
        conversationId: 'requester-thread',
        requestId: 'request-1',
        requestReplyToConversationId: 'reviewer-thread',
        requestReplyToUserId: 'reviewer-id',
        model: 'gpt-test',
      },
    };

    await relayRequestParticipantReply({
      req: replyReq,
      userId: 'requester-id',
      userMessage: { messageId: 'answer-1', text: 'The producer is claims-status-api.' },
      response: { text: 'I sent the service name to the reviewer.' },
    });
    await relayRequestParticipantReply({
      req: replyReq,
      userId: 'requester-id',
      userMessage: { messageId: 'answer-2', text: 'It can write the outbox row in the status transaction.' },
      response: { text: 'I sent the transaction detail to the reviewer.' },
    });

    const relayedMessages = db.saveMessage.mock.calls.map(([, message]) => message);
    expect(relayedMessages).toHaveLength(2);
    expect(relayedMessages[0]).toEqual(expect.objectContaining({
      conversationId: 'reviewer-thread',
      text: expect.stringContaining('The producer is claims-status-api.'),
    }));
    expect(relayedMessages[1]).toEqual(expect.objectContaining({
      conversationId: 'reviewer-thread',
      text: expect.stringContaining('It can write the outbox row in the status transaction.'),
    }));
    expect(db.getMessages).not.toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'requester-thread' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('advances a shared-link snapshot to the latest message when sharing a request thread', async () => {
    db.getSharedLink.mockResolvedValue({ success: true, shareId: 'existing-share', _id: 'share-object-id' });
    db.getMessages.mockResolvedValue([{ messageId: 'latest-message-id' }]);
    db.findUsers.mockResolvedValue([
      { _id: 'requester-id', email: 'requester@example.com', name: 'Requester' },
    ]);
    const shares = await ensureRequestThreadShares({
      req,
      threads: [{ conversationId: 'requester-thread', user: 'requester-id', requestRole: 'requester' }],
      participantIds: ['requester-id', 'collaborator-id'],
    });

    expect(shares[0]).toEqual(expect.objectContaining({
      label: 'Request started by Requester',
      role: 'requester',
      link: expect.stringContaining('/share/'),
    }));

    expect(db.updateSharedLink).toHaveBeenCalledWith(
      'requester-id',
      'existing-share',
      'latest-message-id',
      undefined,
      false,
      undefined,
    );
    expect(db.grantPermission).toHaveBeenCalledWith(
      'user',
      'collaborator-id',
      'sharedLink',
      'share-object-id',
      1,
      'requester-id',
      undefined,
      'viewer-role-id',
    );
  });

  it('returns a participant email explicitly with request context for reliable routing', async () => {
    db.findUsers.mockResolvedValue([
      { _id: 'requester-id', email: 'requester@example.com', name: 'Requester' },
    ]);
    const [, getRequestContext] = createRequestThreadTools({ req, agentId: 'architect-agent' });

    const context = JSON.parse(await getRequestContext.invoke({ query: 'Who requested this and why?' }));

    expect(context.summary).toBe('Claims status updates feed two consumers.');
    expect(context.threads[0]).toEqual(expect.objectContaining({
      participant: 'Requester',
      email: 'requester@example.com',
      role: 'approver',
    }));
  });

  it('labels shared context threads by their participant rather than listing anonymous links', async () => {
    const conversations = new Map();
    db.getConvo.mockImplementation(async (userId, conversationId) =>
      userId === req.user.id && conversationId === source.conversationId
        ? source
        : conversations.get(`${userId}:${conversationId}`) ?? null,
    );
    db.saveConvo.mockImplementation(async ({ userId }, convo) => {
      const saved = { ...conversations.get(`${userId}:${convo.conversationId}`), ...convo, user: userId };
      conversations.set(`${userId}:${convo.conversationId}`, saved);
      return saved;
    });
    db.getRequestConversations.mockResolvedValue([
      { conversationId: source.conversationId, user: 'requester-id', requestRole: 'requester' },
      { conversationId: 'security-thread', user: 'security-id', requestRole: 'approver' },
      { conversationId: 'devops-thread', user: 'devops-id', requestRole: 'collaborator' },
    ]);
    db.findUsers.mockResolvedValue([
      { _id: 'admin-id', email: 'admin@example.com', name: 'Admin', tenantId: 'tenant-a' },
      { _id: 'requester-id', email: 'requester@example.com', name: 'Karthikeyan' },
      { _id: 'security-id', email: 'security@example.com', name: 'Security Reviewer' },
      { _id: 'devops-id', email: 'devops@example.com', name: 'DevOps Executor' },
    ]);
    const [messageParticipant] = createRequestThreadTools({ req, agentId: 'architect-agent' });

    await messageParticipant.invoke({
      email: 'admin@example.com',
      message: 'Please review the proposed design.',
      role: 'approver',
    });

    const handoff = db.saveMessage.mock.calls.at(-1)[1].text;
    expect(handoff).toContain('Thread to Karthikeyan: http://localhost:3080/share/');
    expect(handoff).toContain('Thread to Security Reviewer: http://localhost:3080/share/');
    expect(handoff).toContain('Thread to DevOps Executor: http://localhost:3080/share/');
  });

  it('does not append the same participant answer twice after a retry', async () => {
    db.getConvo.mockResolvedValue({ requestId: 'request-1' });
    db.getMessages.mockResolvedValueOnce([{ messageId: 'already-relayed' }]);
    const replyReq = {
      user: { id: 'collaborator-id' },
      body: { conversationId: 'collaborator-thread' },
      config: { requestTracker: { enabled: true, deploymentId: 'local' } },
      resolvedConversation: {
        requestId: 'request-1',
        requestReplyToConversationId: 'requester-thread',
        requestReplyToUserId: 'requester-id',
      },
    };

    await relayRequestParticipantReply({
      req: replyReq,
      userId: 'collaborator-id',
      userMessage: { messageId: 'answer-1', text: 'Done.' },
      response: { text: 'Thanks.' },
    });

    expect(db.saveMessage).not.toHaveBeenCalled();
    expect(db.saveConvo).not.toHaveBeenCalled();
  });
});
