const { updateTrackedRequest } = require('@librechat/api');
const db = require('~/models');
const {
  appendAssistantMessage,
  ensureRequestThreadShares,
  loadRequestContext,
} = require('./requestThreads');
const { createRequestDecisionTool } = require('./requestDecision');

jest.mock('@librechat/api', () => ({ updateTrackedRequest: jest.fn() }));
jest.mock('~/models', () => ({ getConvo: jest.fn() }));
jest.mock('./requestThreads', () => ({
  appendAssistantMessage: jest.fn(),
  ensureRequestThreadShares: jest.fn(),
  loadRequestContext: jest.fn(),
  stableUUID: jest.fn(() => 'decision-message'),
}));

describe('record_request_decision authority', () => {
  const req = {
    user: { id: 'reviewer', email: 'reviewer@example.com', role: 'USER', tenantId: 'tenant-a' },
    body: { conversationId: 'review-chat' },
    config: { requestTracker: { enabled: true } },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    loadRequestContext.mockResolvedValue({
      user: req.user,
      requestId: 'request-1',
      planRevision: 1,
      threads: [{ conversationId: 'review-chat', user: 'reviewer', requestRole: 'approver' }],
    });
    updateTrackedRequest.mockResolvedValue({
      chats: [{ userId: 'requester', conversationId: 'request-chat', role: 'requester' }],
    });
    db.getConvo.mockResolvedValue({ conversationId: 'request-chat', requestId: 'request-1' });
  });

  it('allows a non-admin account to decide when the tracker assigns its chat as approver', async () => {
    const tool = createRequestDecisionTool({ req });

    const result = JSON.parse(await tool.invoke({ decision: 'approved', planRevision: 1 }));

    expect(result.status).toBe('recorded');
    expect(updateTrackedRequest).toHaveBeenCalledWith(
      req.config.requestTracker,
      undefined,
      'request-1',
      'tenant-a',
      'reviewer',
      { status: 'approved', conditions: [], validUntil: undefined, expectedPlanRevision: 1 },
    );
    expect(appendAssistantMessage).toHaveBeenCalled();
  });

  it('does not let a participant without a tracker approver assignment record a decision', async () => {
    loadRequestContext.mockResolvedValue({
      user: req.user,
      requestId: 'request-1',
      planRevision: 1,
      threads: [{ conversationId: 'review-chat', user: 'reviewer', requestRole: 'collaborator' }],
    });
    const tool = createRequestDecisionTool({ req });

    await expect(tool.invoke({ decision: 'approved', planRevision: 1 }))
      .rejects.toThrow('This chat is not linked as an approver chat for the request.');
    expect(updateTrackedRequest).not.toHaveBeenCalled();
  });
});
