const { DynamicStructuredTool } = require('@librechat/agents/langchain/tools');
const { z } = require('zod');
const { createHash } = require('node:crypto');
const { updateTrackedRequest } = require('@librechat/api');
const db = require('~/models');
const {
  appendAssistantMessage,
  ensureRequestThreadShares,
  loadRequestContext,
  stableUUID,
} = require('./requestThreads');

function createRequestDecisionTool({ req }) {
  return new DynamicStructuredTool({
    name: 'record_request_decision',
    description:
      'Record an explicit approver decision for the current request. Use only after the approver clearly approves or rejects. Stores conditions and an optional expiry, then relays the decision to the original requester chat automatically. This does not provision infrastructure.',
    schema: z.object({
      decision: z.enum(['approved', 'rejected']),
      conditions: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
      validUntil: z.string().datetime().optional(),
      note: z.string().trim().max(4000).optional(),
    }),
    func: async ({ decision, conditions = [], validUntil, note }) => {
      if (String(req?.user?.role).toUpperCase() !== 'ADMIN') {
        throw new Error('Only an assigned approver can record this decision.');
      }
      const context = await loadRequestContext(req);
      const currentChat = context.threads.find(
        (thread) => thread.conversationId === req.body.conversationId && String(thread.user) === context.user.id,
      );
      if (!currentChat || currentChat.requestRole !== 'approver') {
        throw new Error('This chat is not linked as an approver chat for the request.');
      }
      if (validUntil && Date.parse(validUntil) <= Date.now()) {
        throw new Error('The approval expiry must be in the future.');
      }
      if (req?.config?.requestTracker?.enabled !== true) {
        throw new Error('Request tracking is not configured. Contact the platform administrator.');
      }

      const request = await updateTrackedRequest(
        req.config.requestTracker,
        process.env.CONTROL_PLANE_TOKEN,
        context.requestId,
        context.user.tenantId || 'default',
        context.user.id,
        { status: decision, conditions, validUntil },
      );
      const requesterChat = request.chats.find((chat) => chat.role === 'requester');
      if (!requesterChat) {
        throw new Error('The original request chat could not be found. Contact the platform administrator.');
      }
      const requesterConversation = await db.getConvo(requesterChat.userId, requesterChat.conversationId);
      if (!requesterConversation || requesterConversation.requestId !== context.requestId) {
        throw new Error('The original request chat could not be verified. Contact the platform administrator.');
      }

      const decisionLabel = decision === 'approved' ? 'Approved' : 'Rejected';
      const participant = context.user.name || context.user.email || context.user.id;
      const text = [
        `Decision from ${participant}: ${decisionLabel}.`,
        ...(note ? ['', note.trim()] : []),
        ...(conditions.length ? ['', 'Conditions:', ...conditions.map((condition) => `- ${condition.trim()}`)] : []),
        ...(validUntil ? ['', `Valid until: ${new Date(validUntil).toISOString()}`] : []),
        '',
        'No infrastructure changes have been made.',
      ].join('\n');
      const dedupeKey = [context.requestId, req.body.conversationId, decision, text].join('\0');
      const messageId = stableUUID(`request-decision:${createHash('sha256').update(dedupeKey).digest('hex')}`);
      await appendAssistantMessage({
        userId: requesterChat.userId,
        conversation: requesterConversation,
        text,
        messageId,
      });
      await ensureRequestThreadShares({
        req,
        threads: request.chats.map((chat) => ({
          conversationId: chat.conversationId,
          user: chat.userId,
          requestRole: chat.role,
        })),
        requestId: context.requestId,
        participantIds: [...new Set(request.chats.map((chat) => chat.userId))],
      });
      return JSON.stringify({
        status: 'recorded',
        requestId: context.requestId,
        decision,
        requesterConversationId: requesterChat.conversationId,
        message: 'The decision was recorded and sent to the requester in the original request chat.',
      });
    },
  });
}

module.exports = { createRequestDecisionTool };
