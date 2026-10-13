const db = require('../../../../models');
const { createApprovalTool } = require('./adminApproval');

jest.mock('../../../../models', () => ({
  getConvo: jest.fn(),
  findUsers: jest.fn(),
  getMessages: jest.fn(),
  findRoleByIdentifier: jest.fn(),
  getSharedLink: jest.fn(),
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
  createShareContentPreflight: jest.fn(() => undefined),
  grantCreationPermissions: jest.fn(),
}));

describe('request_admin_approval tool', () => {
  const req = {
    user: {
      id: '64b000000000000000000001',
      email: 'developer@example.com',
      name: 'Developer',
      role: 'USER',
      tenantId: 'tenant-a',
    },
    body: { conversationId: 'source-conversation' },
    config: {},
  };

  beforeEach(() => {
    jest.clearAllMocks();
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
    db.findUsers.mockResolvedValue([{
      _id: '64b000000000000000000002',
      email: 'approver@example.com',
      name: 'Approver',
      role: 'ADMIN',
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
  });

  it('routes a confirmed non-admin request to admins without asking the requester for an email', async () => {
    const tool = createApprovalTool({ req, agentId: 'architect-agent', toolName: 'request_admin_approval' });
    expect(tool.schema.shape).not.toHaveProperty('approverEmail');
    const result = JSON.parse(
      await tool.invoke({
        title: 'Claim status event delivery',
        summary: 'Use an outbox and SQS FIFO; no infrastructure change has been made.',
      }),
    );

    expect(result.status).toBe('submitted');
    expect(result.approvers).toEqual(['approver@example.com']);
    expect(result.sourceLink).toBe('http://localhost:3080/share/private-share-id');
    expect(db.findUsers).toHaveBeenCalledWith(
      { role: 'ADMIN', tenantId: 'tenant-a' },
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
      expect.objectContaining({ sender: 'assistant', text: expect.stringContaining(result.sourceLink) }),
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

  it('rejects a conversation that is not owned by the requester', async () => {
    db.getConvo.mockResolvedValue(null);
    const tool = createApprovalTool({ req, agentId: 'architect-agent', toolName: 'request_admin_approval' });

    await expect(
      tool.invoke({ title: 'Review request', approverEmail: 'approver@example.com', summary: 'Proposed plan.' }),
    ).rejects.toThrow('The current conversation is not owned by the signed-in user.');
    expect(db.findUsers).not.toHaveBeenCalled();
    expect(db.createSharedLink).not.toHaveBeenCalled();
  });

  it('fails rather than claiming success when no administrator is available', async () => {
    db.findUsers.mockResolvedValue([]);
    const tool = createApprovalTool({ req, agentId: 'architect-agent', toolName: 'request_admin_approval' });

    await expect(
      tool.invoke({ title: 'Review request', approverEmail: 'missing@example.com', summary: 'Proposed plan.' }),
    ).rejects.toThrow('No administrator is available to review this request.');
    expect(db.createSharedLink).not.toHaveBeenCalled();
  });
});
