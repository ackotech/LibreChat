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
  createShareContentPreflight: jest.fn(() => undefined),
  grantCreationPermissions: jest.fn(),
}));

const { resolveRequestChat } = require('@librechat/api');

describe('request-linked participant chats', () => {
  const source = {
    conversationId: 'requester-thread',
    requestId: 'request-1',
    requestRole: 'requester',
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
      { _id: 'collaborator-id', email: 'collaborator@example.com', name: 'Collaborator' },
    ]);
    db.saveConvo.mockImplementation(async ({ userId }, convo) => {
      const saved = { ...convo, user: userId };
      conversations.set(`${userId}:${convo.conversationId}`, saved);
      return saved;
    });
    db.getMessages.mockResolvedValue([]);
    resolveRequestChat.mockResolvedValue({ id: 'request-1', summary: 'Claims status updates feed two consumers.' });
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
    expect(db.saveMessage.mock.calls[0][1].text).toContain('Request started by requester');
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

  it('recovers an admin review chat linked by its read-only source link instead of making a new request', async () => {
    const reviewId = 'admin-review-thread';
    const requestId = 'request-1';
    const review = {
      conversationId: reviewId,
      title: 'Add Life-Claims SQS Queue',
      requestId: 'stale-request-id',
      requestRole: 'requester',
      user: 'admin-id',
    };
    const sourceConversation = { ...source, requestId, requestRole: 'requester' };
    const recoveredConversations = new Map([
      [`admin-id:${reviewId}`, review],
      [`requester-id:${source.conversationId}`, sourceConversation],
    ]);
    db.getConvo.mockImplementation(async (userId, id) => recoveredConversations.get(`${userId}:${id}`) ?? null);
    db.saveConvo.mockImplementation(async ({ userId }, convo) => {
      const saved = { ...recoveredConversations.get(`${userId}:${convo.conversationId}`), ...convo, user: userId };
      recoveredConversations.set(`${userId}:${convo.conversationId}`, saved);
      return saved;
    });
    const adminReq = {
      user: { id: 'admin-id', email: 'admin@example.com', role: 'ADMIN', tenantId: 'tenant-a' },
      body: { conversationId: reviewId },
      config: { requestTracker: { enabled: true, deploymentId: 'local' } },
    };
    db.getMessages.mockResolvedValue([{
      messageId: 'review-message',
      text: 'Review requested from an administrator. Read-only source conversation: http://localhost:3080/share/source-share',
    }]);
    db.getSharedLinkByShareId.mockResolvedValue({
      shareId: 'source-share',
      conversationId: source.conversationId,
      user: 'requester-id',
      _id: 'share-object',
    });
    db.findUsers.mockResolvedValue([{ _id: 'requester-id', tenantId: 'tenant-a' }]);
    db.getRequestConversations.mockResolvedValue([
      { conversationId: source.conversationId, user: 'requester-id', requestRole: 'requester' },
      { conversationId: reviewId, user: 'admin-id', requestRole: 'approver' },
    ]);

    const [messageParticipant] = createRequestThreadTools({ req: adminReq, agentId: 'architect-agent' });
    await expect(messageParticipant.invoke({
      email: 'requester@example.com',
      message: 'Please clarify the queue owner.',
    })).resolves.toContain('"status":"sent"');

    expect(db.saveConvo).toHaveBeenCalledWith(
      { userId: 'admin-id' },
      expect.objectContaining({
        conversationId: reviewId,
        requestId,
        requestRole: 'approver',
      }),
      expect.objectContaining({ context: 'recover request review chat' }),
    );
  });

  it('recovers a non-admin reviewer chat from its source link before resolving the tracked request', async () => {
    const reviewId = 'security-review-thread';
    const reviewerId = 'security-id';
    const requestId = 'request-1';
    const review = {
      conversationId: reviewId,
      title: 'Review: Claims status event fan-out',
      requestId: 'incorrect-new-request',
      requestRole: 'requester',
      user: reviewerId,
    };
    const sourceConversation = { ...source, requestId, requestRole: 'requester' };
    const conversations = new Map([
      [`${reviewerId}:${reviewId}`, review],
      [`requester-id:${source.conversationId}`, sourceConversation],
    ]);
    db.getConvo.mockImplementation(async (userId, id) => conversations.get(`${userId}:${id}`) ?? null);
    db.saveConvo.mockImplementation(async ({ userId }, convo) => {
      const saved = { ...conversations.get(`${userId}:${convo.conversationId}`), ...convo, user: userId };
      conversations.set(`${userId}:${convo.conversationId}`, saved);
      return saved;
    });
    db.getMessages.mockResolvedValue([{
      messageId: 'review-message',
      text: 'Please assess the proposal. Read-only source conversation: http://localhost:3080/share/source-share',
    }]);
    db.getSharedLinkByShareId.mockResolvedValue({
      shareId: 'source-share',
      conversationId: source.conversationId,
      user: 'requester-id',
    });
    db.findUsers.mockResolvedValue([{ _id: 'requester-id', tenantId: 'tenant-a' }]);
    db.getRequestConversations.mockResolvedValue([
      { conversationId: source.conversationId, user: 'requester-id', requestRole: 'requester' },
      { conversationId: reviewId, user: reviewerId, requestRole: 'approver' },
    ]);
    resolveRequestChat.mockResolvedValue({ id: requestId, summary: 'Claims status updates feed two consumers.' });
    const reviewerReq = {
      user: { id: reviewerId, email: 'security@example.com', role: 'USER', tenantId: 'tenant-a' },
      body: { conversationId: reviewId },
      config: { requestTracker: { enabled: true, deploymentId: 'local' } },
    };

    const context = await loadRequestContext(reviewerReq);

    expect(context.requestId).toBe(requestId);
    expect(context.conversation.requestRole).toBe('approver');
    expect(resolveRequestChat).toHaveBeenCalledWith(
      reviewerReq.config.requestTracker,
      undefined,
      expect.objectContaining({ requestId, role: 'approver' }),
    );
    expect(db.saveConvo).toHaveBeenCalledWith(
      { userId: reviewerId },
      { conversationId: reviewId, requestId, requestRole: 'approver' },
      { context: 'recover request review chat' },
    );
  });

  it('fails closed when an admin review chat cannot recover its original request', async () => {
    const adminReq = {
      user: { id: 'admin-id', role: 'ADMIN', tenantId: 'tenant-a' },
      body: { conversationId: 'review-thread' },
    };
    db.getConvo.mockResolvedValue({
      conversationId: 'review-thread',
      title: 'Add Life-Claims SQS Queue',
      requestId: 'stale-request-id',
      requestRole: 'requester',
    });
    db.getMessages.mockResolvedValue([{
      text: 'Review requested from the requester. Read-only source conversation: /share/expired-share',
    }]);
    db.getSharedLinkByShareId.mockResolvedValue(null);

    await expect(loadRequestContext(adminReq)).rejects.toThrow('This review chat could not be safely linked to its request.');
    expect(db.saveConvo).not.toHaveBeenCalled();
  });

  it('does not invent a new request when a participant chat has lost its request link', async () => {
    const participantConversation = {
      conversationId: 'security-review-thread',
      title: 'Security review',
      requestRole: 'collaborator',
      agent_id: 'architect-agent',
    };
    db.getConvo.mockResolvedValue(participantConversation);
    db.getRequestConversations.mockResolvedValue([
      { conversationId: participantConversation.conversationId, user: 'security-id', requestRole: 'collaborator' },
    ]);
    const participantReq = {
      user: { id: 'security-id', email: 'security@example.com', tenantId: 'tenant-a' },
      body: { conversationId: participantConversation.conversationId },
    };

    await expect(loadRequestContext(participantReq)).rejects.toThrow('This chat is not linked to a request.');
    expect(db.saveConvo).not.toHaveBeenCalled();
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
      role: 'requester',
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
      { _id: 'admin-id', email: 'admin@example.com', name: 'Admin' },
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
    expect(handoff).toContain('Request started by Karthikeyan: http://localhost:3080/share/');
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
