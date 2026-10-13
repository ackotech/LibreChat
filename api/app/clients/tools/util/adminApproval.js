const { DynamicStructuredTool } = require('@librechat/agents/langchain/tools');
const { z } = require('zod');
const {
  AccessRoleIds,
  PrincipalType,
  ResourceType,
} = require('librechat-data-provider');
const { createHash } = require('node:crypto');
const db = require('~/models');
const { createShareContentPreflight, grantCreationPermissions } = require('@librechat/api');
const { createAgentAccessCheck } = require('~/server/controllers/agents/steer');

function stableUUID(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const raw = hex.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function createApprovalTool({ req, agentId, toolName = 'request_approval' }) {
  const isAdminApproval = toolName === 'request_admin_approval';
  const schema = z.object({
    title: z.string().min(1).max(120).describe('Short title for the review request.'),
    ...(!isAdminApproval && {
      approverEmail: z.string().email().describe('Email of the person assigned to approve this request.'),
    }),
    summary: z
      .string()
      .min(1)
      .max(8000)
      .describe('The agreed plan, rationale, risks, assumptions, and requested approval.'),
  });
  return new DynamicStructuredTool({
    name: toolName,
    description:
      'Submit a completed change plan from a non-admin requester to eligible LibreChat administrators for approval. Creates a private read-only source link and reuses one 1:1 review chat per administrator for this request. Use automatically after the requester confirms the plan; do not ask for an approver email. Does not execute infrastructure changes.',
    schema,
    func: async ({ title, approverEmail, summary }) => {
      const requester = req?.user;
      if (!requester?.id || !requester?.role) {
        throw new Error('The signed-in user could not be verified.');
      }
      const conversationId = req?.body?.conversationId;
      if (typeof conversationId !== 'string' || !conversationId) {
        throw new Error('Could not identify the current conversation.');
      }
      const sourceConversation = await db.getConvo(requester.id, conversationId);
      if (!sourceConversation) {
        throw new Error('The current conversation is not owned by the signed-in user.');
      }
      const requestId =
        sourceConversation.requestId ||
        stableUUID([requester.tenantId || '', requester.id, conversationId].join('\0'));
      await db.saveConvo(
        { userId: requester.id },
        { conversationId, requestId, requestRole: 'requester' },
        { context: 'admin approval handoff' },
      );
      const linkedSource = await db.getConvo(requester.id, conversationId);
      if (!linkedSource || linkedSource.requestId !== requestId || linkedSource.requestRole !== 'requester') {
        throw new Error('The original request chat could not be linked for review.');
      }

      if (isAdminApproval && String(requester.role).toUpperCase() === 'ADMIN') {
        throw new Error('An administrator cannot submit their own request for admin approval.');
      }
      let approvers;
      if (isAdminApproval) {
        approvers = await db.findUsers(
          { role: 'ADMIN', tenantId: requester.tenantId ?? null },
          '_id email name role tenantId',
          { limit: 100, sort: { email: 1 } },
        );
      } else {
        if (!approverEmail) {
          throw new Error('An approver email is required for request_approval.');
        }
        approvers = await db.findUsers(
          {
            email: approverEmail.trim().toLowerCase(),
            tenantId: requester.tenantId ?? null,
          },
          '_id email name role tenantId',
          { limit: 1 },
        );
      }
      if (!approvers.length) {
        throw new Error(
          isAdminApproval
            ? 'No administrator is available to review this request.'
            : 'The assigned approver could not be found in your organization.',
        );
      }
      approvers = approvers.filter((approver) => String(approver._id) !== requester.id);
      if (!approvers.length) {
        throw new Error('The requester cannot be the approver for their own request.');
      }
      const accessCheck = createAgentAccessCheck(req);
      const authorizedApprovers = [];
      for (const approver of approvers) {
        const approverReq = { ...req, user: { ...approver, id: String(approver._id) } };
        const canUseAgent = await createAgentAccessCheck(approverReq)({
          agentId,
          endpoint: sourceConversation.endpoint || 'agents',
        });
        if (canUseAgent) authorizedApprovers.push(approver);
      }
      if (!authorizedApprovers.length) {
        throw new Error('No eligible approver has access to this agent. Ask an agent administrator to grant access.');
      }
      const sharedLinkViewerRole = await db.findRoleByIdentifier(AccessRoleIds.SHARED_LINK_VIEWER);
      if (!sharedLinkViewerRole) {
        throw new Error('The shared-link viewer permission role is not configured.');
      }

      const priorShare = await db.getSharedLink(requester.id, conversationId);
      let shareId = priorShare?.shareId;
      let sharedLinkId = priorShare?._id;
      if (!shareId) {
        const preflight = createShareContentPreflight(req.config?.filters, {
          snapshotFiles: false,
          user: requester,
          getFiles: db.getFiles,
          sharedFileMetadata: true,
          sharedFileMetadataFiles: false,
          legacyPii: req.config?.messageFilter?.pii,
        });
        const share = await db.createSharedLink(
          requester.id,
          conversationId,
          undefined,
          undefined,
          false,
          ...(preflight == null ? [] : [preflight]),
        );
        await grantCreationPermissions(share._id, requester.id, false);
        shareId = share.shareId;
        sharedLinkId = share._id;
      }

      const sourceLink = `${(process.env.DOMAIN_CLIENT || 'http://localhost:3080').replace(/\/$/, '')}/share/${shareId}`;
      const reviewConversationIds = [];
      for (const approver of authorizedApprovers) {
        const approverId = String(approver._id);
        const reviewConversationId = stableUUID(`request-thread:${requestId}:${approverId}`);
        const messageId = stableUUID(
          `request-review-update:${requestId}:${approverId}:${createHash('sha256').update(summary.trim()).digest('hex')}`,
        );
        const reviewText = [
          `Review requested from ${approver.name || approver.email || approverId} by ${requester.name || requester.email || requester.id}.`,
          '',
          `Request: ${title.trim()}`,
          '',
          summary.trim(),
          '',
          `Read-only source conversation: ${sourceLink}`,
          '',
          'Please discuss your decision here. No infrastructure changes have been made.',
        ].join('\n');

        await db.grantPermission(
          PrincipalType.USER,
          approverId,
          ResourceType.SHARED_LINK,
          sharedLinkId,
          sharedLinkViewerRole.permBits,
          requester.id,
          undefined,
          sharedLinkViewerRole._id,
        );
        const existingReview = await db.getConvo(approverId, reviewConversationId);
        const existingMessages = existingReview
          ? await db.getMessages({ user: approverId, conversationId: reviewConversationId }, 'messageId')
          : [];
        const isFirstMessage = existingMessages.length === 0;
        const savedMessage = await db.saveMessage(
          { userId: approverId },
          {
            conversationId: reviewConversationId,
            messageId,
            ...(isFirstMessage
              ? { sender: 'assistant', text: reviewText, parentMessageId: '00000000-0000-0000-0000-000000000000' }
              : {
                  sender: 'assistant',
                  text: `Request update from ${requester.name || requester.email || requester.id}.\n\n${summary.trim()}`,
                  parentMessageId: existingMessages[existingMessages.length - 1].messageId,
                }),
            isCreatedByUser: false,
            model: 'request-review',
            endpoint: 'agents',
          },
          { context: 'request approval handoff' },
        );
        if (!savedMessage) {
          throw new Error('Could not persist the request update for the approver.');
        }
        await db.saveConvo(
          { userId: approverId },
          {
            conversationId: reviewConversationId,
            title: `Review: ${title.trim()}`,
            endpoint: 'agents',
            agent_id: agentId,
            requestId,
            requestRole: 'approver',
          },
          { context: 'request approval handoff' },
        );
        const savedReview = await db.getConvo(approverId, reviewConversationId);
        if (
          !savedReview ||
          savedReview.requestId !== requestId ||
          savedReview.requestRole !== 'approver'
        ) {
          throw new Error('The approver review chat could not be linked to the original request.');
        }
        reviewConversationIds.push(reviewConversationId);
      }

      return JSON.stringify({
        status: 'submitted',
        approvers: authorizedApprovers.map((approver) => approver.email),
        sourceLink,
        reviewLinks: reviewConversationIds.map(
          (id) => `${(process.env.DOMAIN_CLIENT || 'http://localhost:3080').replace(/\/$/, '')}/c/${id}`,
        ),
        message: 'The review request was sent. No infrastructure changes have been made.',
      });
    },
  });
}

module.exports = { createApprovalTool, createAdminApprovalTool: createApprovalTool };
