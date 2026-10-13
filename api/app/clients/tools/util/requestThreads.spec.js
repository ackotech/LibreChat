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
  createShareContentPreflight: jest.fn(() => undefined),
  grantCreationPermissions: jest.fn(),
}));

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
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const conversations = new Map();
    db.getConvo.mockImplementation(async (userId, conversationId) =>
      userId === req.user.id && conversationId === source.conversationId
        ? source
        : conversations.get(`${userId}:${conversationId}`) ?? null,
    );
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

    await expect(loadRequestContext(adminReq)).rejects.toThrow('This review chat is missing its request link.');
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

  it('advances a shared-link snapshot to the latest message when sharing a request thread', async () => {
    db.getSharedLink.mockResolvedValue({ success: true, shareId: 'existing-share', _id: 'share-object-id' });
    db.getMessages.mockResolvedValue([{ messageId: 'latest-message-id' }]);
    await ensureRequestThreadShares({
      req,
      threads: [{ conversationId: 'requester-thread', user: 'requester-id', requestRole: 'requester' }],
      participantIds: ['requester-id', 'collaborator-id'],
    });

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

  it('does not append the same participant answer twice after a retry', async () => {
    db.getConvo.mockResolvedValue({ requestId: 'request-1' });
    db.getMessages.mockResolvedValueOnce([{ messageId: 'already-relayed' }]);
    const replyReq = {
      user: { id: 'collaborator-id' },
      body: { conversationId: 'collaborator-thread' },
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
