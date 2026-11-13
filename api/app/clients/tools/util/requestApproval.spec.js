const db = require('../../../../models');
const { createApprovalTool } = require('./requestApproval');

jest.mock('../../../../models', () => ({
  getConvo: jest.fn(),
  findUsers: jest.fn(),
  findRolesByNames: jest.fn(),
  findGroupsByNamePattern: jest.fn(),
  getMessages: jest.fn(),
  findRoleByIdentifier: jest.fn(),
  getSharedLink: jest.fn(),
  getRequestConversations: jest.fn(),
  createSharedLink: jest.fn(),
  getFiles: jest.fn(),
  grantPermission: jest.fn(),
  saveMessage: jest.fn(),
  saveConvo: jest.fn(),
}));

jest.mock('~/server/controllers/agents/steer', () => ({
  createAgentAccessCheck: jest.fn(() => jest.fn().mockResolvedValue(true)),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  resolveRequestChat: jest.fn(),
  updateTrackedRequest: jest.fn(),
  createShareContentPreflight: jest.fn(() => undefined),
  grantCreationPermissions: jest.fn(),
}));

const { resolveRequestChat, updateTrackedRequest } = require('@librechat/api');

describe('request_approval role handoff tool', () => {
  const req = {
    user: {
      id: '64b000000000000000000001',
      email: 'developer@example.com',
      name: 'Developer',
      role: 'USER',
      tenantId: 'tenant-a',
    },
    body: { conversationId: 'source-conversation' },
    config: { requestTracker: { enabled: true, deploymentId: 'local' } },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resolveRequestChat.mockResolvedValue({ id: 'request-test' });
    updateTrackedRequest.mockResolvedValue({ id: 'request-test' });
    const conversations = new Map();
    db.getConvo.mockImplementation(async (userId, conversationId) => {
      if (userId === req.user.id && conversationId === req.body.conversationId) {
        return conversations.get(`${userId}:${conversationId}`) ?? {
          conversationId: req.body.conversationId,
          endpoint: 'agents',
        };
      }
      return conversations.get(`${userId}:${conversationId}`) ?? null;
    });
    db.findRolesByNames.mockResolvedValue([]);
    db.findGroupsByNamePattern.mockResolvedValue([]);
    db.findUsers.mockResolvedValue([{
      _id: '64b000000000000000000002',
      email: 'approver@example.com',
      name: 'Approver',
      role: 'ADMIN',
      tenantId: 'tenant-a',
    }]);
    db.findRoleByIdentifier.mockResolvedValue({ _id: '64b000000000000000000003', permBits: 1 });
    db.getSharedLink.mockResolvedValue({ success: false, shareId: null });
    db.createSharedLink.mockResolvedValue({ _id: 'share-object-id', shareId: 'private-share-id' });
    db.grantPermission.mockResolvedValue({});
    db.saveMessage.mockResolvedValue({});
    db.saveConvo.mockImplementation(async ({ userId }, convo) => {
      const saved = { ...convo, user: userId };
      conversations.set(`${userId}:${convo.conversationId}`, saved);
      return saved;
    });
    db.getMessages.mockResolvedValue([]);
    db.getRequestConversations.mockResolvedValue([
      { conversationId: 'source-conversation', user: req.user.id, requestRole: 'requester' },
    ]);
  });

  it('resolves the policy role against the authenticated tenant directory', async () => {
    const tool = createApprovalTool({ req, agentId: 'architect-agent' });
    expect(tool.schema.shape).toHaveProperty('recipientRole');
    expect(tool.schema.shape).not.toHaveProperty('approverEmail');

    const result = JSON.parse(await tool.invoke({
      title: 'Claim status event delivery',
      recipientRole: 'ADMIN',
      summary: 'Use an outbox and SQS FIFO; no infrastructure change has been made.',
    }));

    expect(result.status).toBe('submitted');
    expect(result.recipientRole).toBe('ADMIN');
    expect(result.approvers).toEqual(['approver@example.com']);
    expect(result.sourceLink).toBe('http://localhost:3080/share/private-share-id');
    expect(db.findUsers).toHaveBeenNthCalledWith(
      1,
      { role: { $in: ['ADMIN'] }, tenantId: 'tenant-a' },
      '_id email name role tenantId',
      { limit: 100, sort: { email: 1 } },
    );
    expect(require('@librechat/api').grantCreationPermissions).toHaveBeenCalledWith(
      'share-object-id',
      req.user.id,
      false,
    );
    expect(db.grantPermission).toHaveBeenCalledWith(
      'user',
      '64b000000000000000000002',
      'sharedLink',
      'share-object-id',
      1,
      req.user.id,
      undefined,
      '64b000000000000000000003',
    );
    expect(db.saveMessage).toHaveBeenCalledWith(
      { userId: '64b000000000000000000002' },
      expect.objectContaining({
        sender: 'assistant',
        text: expect.stringContaining(`Request thread with Developer (requester): ${result.sourceLink}`),
      }),
      { context: 'request approval handoff' },
    );
    expect(db.saveConvo).toHaveBeenCalledWith(
      { userId: '64b000000000000000000002' },
      expect.objectContaining({
        title: 'Review: Claim status event delivery',
        agent_id: 'architect-agent',
        requestId: expect.any(String),
        requestRole: 'approver',
      }),
      { context: 'request approval handoff' },
    );
    expect(result.reviewLinks).toHaveLength(1);
  });

  it('resolves a named domain group and routes to its members regardless of LibreChat system role', async () => {
    db.findUsers
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        _id: '64b000000000000000000004',
        email: 'security@example.com',
        name: 'Security Reviewer',
        role: 'USER',
        tenantId: 'tenant-a',
      }]);
    db.findGroupsByNamePattern.mockResolvedValue([{
      name: 'Security Reviewers',
      memberIds: ['64b000000000000000000004'],
      tenantId: 'tenant-a',
    }]);
    const tool = createApprovalTool({ req, agentId: 'architect-agent' });

    const result = JSON.parse(await tool.invoke({
      title: 'Security review',
      recipientRole: 'Security Reviewers',
      summary: 'Review the proposed change.',
    }));

    expect(result.status).toBe('submitted');
    expect(result.approvers).toEqual(['security@example.com']);
    expect(db.findGroupsByNamePattern).toHaveBeenCalledWith('Security Reviewers', null, 100);
    expect(db.findUsers).toHaveBeenNthCalledWith(
      2,
      {
        $or: [
          { _id: { $in: ['64b000000000000000000004'] } },
          { idOnTheSource: { $in: ['64b000000000000000000004'] } },
        ],
        tenantId: 'tenant-a',
      },
      '_id email name role tenantId',
      { limit: 100, sort: { email: 1 } },
    );
  });

  it('does not select a same-named group from another tenant', async () => {
    db.findUsers.mockResolvedValue([]);
    db.findGroupsByNamePattern.mockResolvedValue([{
      name: 'Security Reviewers',
      memberIds: ['64b000000000000000000004'],
      tenantId: 'tenant-b',
    }]);
    const tool = createApprovalTool({ req, agentId: 'architect-agent' });

    await expect(tool.invoke({
      title: 'Security review',
      recipientRole: 'Security Reviewers',
      summary: 'Review the proposed change.',
    })).rejects.toThrow('No users match the requested reviewer role in your organization.');
    expect(db.createSharedLink).not.toHaveBeenCalled();
  });

  it('rejects a conversation that is not owned by the requester', async () => {
    db.getConvo.mockResolvedValue(null);
    const tool = createApprovalTool({ req, agentId: 'architect-agent' });

    await expect(tool.invoke({
      title: 'Review request',
      recipientRole: 'ADMIN',
      summary: 'Proposed plan.',
    })).rejects.toThrow('The current conversation is not owned by the signed-in user.');
    expect(db.findRolesByNames).not.toHaveBeenCalled();
    expect(db.findGroupsByNamePattern).not.toHaveBeenCalled();
    expect(db.findUsers).not.toHaveBeenCalled();
    expect(db.createSharedLink).not.toHaveBeenCalled();
  });

  it('fails without creating a share when the requested role has no users', async () => {
    db.findUsers.mockResolvedValue([]);
    const tool = createApprovalTool({ req, agentId: 'architect-agent' });

    await expect(tool.invoke({
      title: 'Review request',
      recipientRole: 'Security Reviewers',
      summary: 'Proposed plan.',
    })).rejects.toThrow('No users match the requested reviewer role in your organization.');
    expect(db.createSharedLink).not.toHaveBeenCalled();
  });
});
