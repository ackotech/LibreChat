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
const { updateTrackedRequest } = require('@librechat/api');
const { syncTrackedChat, ensureRequestThreadShares } = require('./requestThreads');

function stableUUID(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const raw = hex.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function sameTenant(left, right) {
  return (left?.tenantId ?? null) === (right?.tenantId ?? null);
}

async function resolveRoleRecipients(recipientRole, requester) {
  const tenantId = requester.tenantId ?? null;
  const roleDefinitions = await db.findRolesByNames([recipientRole], '_id name tenantId');
  const roleIds = roleDefinitions
    .filter((role) => role.name?.toLowerCase() === recipientRole.toLowerCase() && sameTenant(role, requester))
    .map((role) => String(role._id));
  const roleNames = [...new Set([recipientRole, recipientRole.toUpperCase(), ...roleIds])];
  const fields = '_id email name role tenantId';
  const options = { limit: 100, sort: { email: 1 } };
  const byRole = await db.findUsers({ role: { $in: roleNames }, tenantId }, fields, options);

  const matchingGroups = (await db.findGroupsByNamePattern(recipientRole, null, 100)).filter(
    (group) => group.name?.toLowerCase() === recipientRole.toLowerCase() && sameTenant(group, requester),
  );
  const memberIds = [...new Set(matchingGroups.flatMap((group) => group.memberIds ?? []))];
  const byGroup = memberIds.length
    ? await db.findUsers(
        {
          $or: [{ _id: { $in: memberIds } }, { idOnTheSource: { $in: memberIds } }],
          tenantId,
        },
        fields,
        options,
      )
    : [];

  return [...new Map([...byRole, ...byGroup].map((user) => [String(user._id), user])).values()];
}

function createApprovalTool({ req, agentId }) {
  const schema = z.object({
    title: z.string().min(1).max(120).describe('Short title for the review request.'),
    recipientRole: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe('Exact LibreChat role or group name selected by the applicable knowledge policy.'),
    summary: z
      .string()
      .min(1)
      .max(8000)
      .describe('The agreed plan, rationale, risks, assumptions, and requested approval.'),
  });
  return new DynamicStructuredTool({
    name: 'request_approval',
    description:
      'Create or update request-linked 1:1 handoff chats for members of the exact LibreChat role or group specified by the Architect from applicable knowledge. This tool resolves directory members, verifies tenant and agent access, links chats, and shares read-only context. It does not decide whether review is required or execute infrastructure changes.',
    schema,
    func: async ({ title, recipientRole, summary }) => {
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
      const tracker = await syncTrackedChat(req, {
        requestId: sourceConversation.requestId,
        conversationId,
        userId: requester.id,
        email: requester.email,
        name: requester.name,
        role: 'requester',
        agentId: sourceConversation.agent_id || agentId,
        title: sourceConversation.title || title,
      });
      const requestId = tracker.id;
      await db.saveConvo(
        { userId: requester.id },
        { conversationId, requestId, requestRole: 'requester' },
        { context: 'admin approval handoff' },
      );
      const linkedSource = await db.getConvo(requester.id, conversationId);
      if (!linkedSource || linkedSource.requestId !== requestId || linkedSource.requestRole !== 'requester') {
        throw new Error('The original request chat could not be linked for review.');
      }

      let approvers = await resolveRoleRecipients(recipientRole, requester);
      if (!approvers.length) {
        throw new Error('No users match the requested reviewer role in your organization.');
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
      await syncTrackedChat(req, {
        requestId,
        conversationId,
        userId: requester.id,
        email: requester.email,
        name: requester.name,
        role: 'requester',
        agentId: sourceConversation.agent_id || agentId,
        title: title.trim(),
        readOnlyUrl: sourceLink,
      });
      if (req?.config?.requestTracker?.enabled === true) {
        await updateTrackedRequest(
          req.config.requestTracker,
          process.env.CONTROL_PLANE_TOKEN,
          requestId,
          requester.tenantId || 'default',
          requester.id,
          { title: title.trim(), summary: summary.trim(), status: 'review' },
        );
      }
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
          `Request thread with ${requester.name || requester.email || 'the requester'} (requester): ${sourceLink}`,
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
        await syncTrackedChat(req, {
          requestId,
          conversationId: reviewConversationId,
          userId: approverId,
          email: approver.email,
          name: approver.name,
          role: 'approver',
          agentId,
          title: `Review: ${title.trim()}`,
        });
        reviewConversationIds.push(reviewConversationId);
      }

      const linkedThreads = await db.getRequestConversations({
        requestId,
        tenantId: requester.tenantId,
      });
      await ensureRequestThreadShares({
        req,
        threads: linkedThreads,
        requestId,
        participantIds: [...new Set(linkedThreads.map((thread) => String(thread.user)))],
      });

      return JSON.stringify({
        status: 'submitted',
        recipientRole,
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

module.exports = { createApprovalTool, resolveRoleRecipients };
