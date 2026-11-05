const { createRequestDecisionTool } = require('./requestDecision');

jest.mock('~/models', () => ({
  getConvo: jest.fn(),
  saveConvo: jest.fn(),
  getRequestConversations: jest.fn(),
}));

describe('approval authority is independent of password login', () => {
  it.each(['librechat-sync@local.dev', 'developer@local.test'])(
    'does not let the USER account %s approve through a custom agent',
    async (email) => {
      const tool = createRequestDecisionTool({
        req: { user: { id: 'user', email, role: 'USER' }, body: { conversationId: 'chat' } },
      });
      await expect(tool.invoke({ decision: 'approved', planRevision: 1 }))
        .rejects.toThrow('Only an assigned approver');
    },
  );
});
