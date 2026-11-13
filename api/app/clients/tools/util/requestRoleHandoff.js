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

function createRoleHandoffTool({ req, agentId }) {
  const schema = z.object({
    title: z.string().min(1).max(120).describe('Short title for this request handoff.'),
    recipientRole: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe('Exact LibreChat role or group name selected by the applicable knowledge policy.'),
    participantRole: z
      .enum(['approver', 'collaborator'])
      .describe('Request relationship selected by the workflow: approver for a decision, collaborator for consultation.'),
    summary: z
      .string()
      .min(1)
      .max(8000)
      .describe('The relevant request context, rationale, risks, assumptions, and question or action needed from the recipient.'),
  });
  return new DynamicStructuredTool({
    name: 'route_request_to_role',
    description:
      'Resolve members of the exact LibreChat role or group selected from applicable knowledge, verify tenant and agent access, then create or update request-linked 1:1 chats and share read-only context. The Architect selects approver versus collaborator from the workflow purpose. This tool only routes and records that relationship; it does not decide policy or execute changes.',
    schema,
    func: async ({ title, recipientRole, participantRole, summary }) => {
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
        { context: 'request role handoff' },
      );
      const linkedSource = await db.getConvo(requester.id, conversationId);
      if (!linkedSource || linkedSource.requestId !== requestId || linkedSource.requestRole !== 'requester') {
        throw new Error('The original request chat could not be linked to the request.');
      }

      let recipients = await resolveRoleRecipients(recipientRole, requester);
      if (!recipients.length) {
        throw new Error('No users match the requested role or group in your organization.');
      }
      recipients = recipients.filter((recipient) => String(recipient._id) !== requester.id);
      if (!recipients.length) {
        throw new Error('The requester cannot be routed to themselves.');
      }
      const accessCheck = createAgentAccessCheck(req);
      const authorizedRecipients = [];
      for (const recipient of recipients) {
        const recipientReq = { ...req, user: { ...recipient, id: String(recipient._id) } };
        const canUseAgent = await createAgentAccessCheck(recipientReq)({
          agentId,
          endpoint: sourceConversation.endpoint || 'agents',
        });
        if (canUseAgent) authorizedRecipients.push(recipient);
      }
      if (!authorizedRecipients.length) {
        throw new Error('No eligible recipient has access to this agent. Ask an agent administrator to grant access.');
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
          {
            title: title.trim(),
            summary: summary.trim(),
            ...(participantRole === 'approver' ? { status: 'review' } : {}),
          },
        );
      }
      const recipientConversationIds = [];
      for (const recipient of authorizedRecipients) {
        const recipientId = String(recipient._id);
        const recipientConversationId = stableUUID(`request-thread:${requestId}:${recipientId}`);
        const messageId = stableUUID(
          `request-role-update:${requestId}:${recipientId}:${createHash('sha256').update(summary.trim()).digest('hex')}`,
        );
        const roleLabel = participantRole === 'approver' ? 'Review' : 'Consultation';
        const recipientName = recipient.name || recipient.email || recipientId;
        const requesterName = requester.name || requester.email || requester.id;
        const handoffText = [
          `${roleLabel} requested from ${recipientName} by ${requesterName}.`,
          '',
          `Request: ${title.trim()}`,
          '',
          summary.trim(),
          '',
          `Request thread with ${requester.name || requester.email || 'the requester'} (requester): ${sourceLink}`,
          '',
          participantRole === 'approver'
            ? 'Please record your decision here. No infrastructure changes have been made.'
            : 'Please discuss the request here. Your messages will be shared with the requester through this linked request.',
        ].join('\n');

        await db.grantPermission(
          PrincipalType.USER,
          recipientId,
          ResourceType.SHARED_LINK,
          sharedLinkId,
          sharedLinkViewerRole.permBits,
          requester.id,
          undefined,
          sharedLinkViewerRole._id,
        );
        const existingRecipientChat = await db.getConvo(recipientId, recipientConversationId);
        const existingMessages = existingRecipientChat
          ? await db.getMessages({ user: recipientId, conversationId: recipientConversationId }, 'messageId')
          : [];
        const isFirstMessage = existingMessages.length === 0;
        const savedMessage = await db.saveMessage(
          { userId: recipientId },
          {
            conversationId: recipientConversationId,
            messageId,
            ...(isFirstMessage
              ? { sender: 'assistant', text: handoffText, parentMessageId: '00000000-0000-0000-0000-000000000000' }
              : {
                  sender: 'assistant',
                  text: `Request update from ${requester.name || requester.email || requester.id}.\n\n${summary.trim()}`,
                  parentMessageId: existingMessages[existingMessages.length - 1].messageId,
                }),
            isCreatedByUser: false,
            model: 'request-handoff',
            endpoint: 'agents',
          },
          { context: 'request role handoff' },
        );
        if (!savedMessage) {
          throw new Error('Could not persist the request update for the recipient.');
        }
        await db.saveConvo(
          { userId: recipientId },
          {
            conversationId: recipientConversationId,
            title: `${roleLabel}: ${title.trim()}`,
            endpoint: 'agents',
            agent_id: agentId,
            requestId,
            requestRole: participantRole,
          },
          { context: 'request role handoff' },
        );
        const savedRecipientChat = await db.getConvo(recipientId, recipientConversationId);
        if (
          !savedRecipientChat ||
          savedRecipientChat.requestId !== requestId ||
          savedRecipientChat.requestRole !== participantRole
        ) {
          throw new Error('The recipient chat could not be linked to the original request.');
        }
        await syncTrackedChat(req, {
          requestId,
          conversationId: recipientConversationId,
          userId: recipientId,
          email: recipient.email,
          name: recipient.name,
          role: participantRole,
          agentId,
          title: `${roleLabel}: ${title.trim()}`,
        });
        recipientConversationIds.push(recipientConversationId);
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
        participantRole,
        recipients: authorizedRecipients.map((recipient) => recipient.email),
        sourceLink,
        participantLinks: recipientConversationIds.map(
          (id) => `${(process.env.DOMAIN_CLIENT || 'http://localhost:3080').replace(/\/$/, '')}/c/${id}`,
        ),
        message:
          participantRole === 'approver'
            ? 'The approval request was sent. No infrastructure changes have been made.'
            : 'The request context was shared with the selected collaborator.',
      });
    },
  });
}

module.exports = { createRoleHandoffTool, resolveRoleRecipients };
