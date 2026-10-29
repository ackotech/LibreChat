const { DynamicStructuredTool } = require('@librechat/agents/langchain/tools');
const { z } = require('zod');
const { randomUUID, createHash } = require('node:crypto');
const { Constants, AccessRoleIds, PrincipalType, ResourceType } = require('librechat-data-provider');
const {
  createShareContentPreflight,
  grantCreationPermissions,
  resolveRequestChat,
} = require('@librechat/api');
const { createAgentAccessCheck } = require('~/server/controllers/agents/steer');
const db = require('~/models');

function stableUUID(value) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const raw = hex.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

async function loadRequestContext(req) {
  const user = req?.user;
  const conversationId = req?.body?.conversationId;
  if (!user?.id || !conversationId) {
    throw new Error('Could not identify the signed-in user and current request chat.');
  }
  const conversation = await db.getConvo(user.id, conversationId);
  if (!conversation) {
    throw new Error('Could not find the current chat for the signed-in user.');
  }
  const isAdmin = String(user.role).toUpperCase() === 'ADMIN';
  const reviewTitle = /^Review:/i.test(conversation.title || '');
  let initialMessages = [];
  if (isAdmin || reviewTitle || conversation.requestRole === 'approver') {
    initialMessages = await db.getMessages(
      { user: user.id, conversationId },
      'text',
      { limit: 8, sort: { createdAt: 1 } },
    );
  }
  const isReviewChat =
    reviewTitle ||
    (initialMessages || []).some((message) => {
      const text = getMessageText(message.text);
      return /Review requested from/i.test(text) && /\/share\/[A-Za-z0-9_-]+/.test(text);
    });
  if (isReviewChat) {
    if (!conversation.requestId || conversation.requestRole !== 'approver') {
      await recoverReviewContext({ user, conversation, conversationId, messages: initialMessages });
    }
    if (!conversation.requestId || conversation.requestRole !== 'approver') {
      throw new Error('This review chat could not be safely linked to its request. No message was sent. Contact the platform administrator.');
    }
  }
  const requestRole = conversation.requestRole || 'requester';
  if (!conversation.requestId && requestRole !== 'requester') {
    throw new Error('This chat is not linked to a request. Reopen it from the original request conversation.');
  }
  const tracked = await syncTrackedChat(req, {
    requestId: conversation.requestId,
    conversationId,
    userId: user.id,
    email: user.email,
    name: user.name,
    role: requestRole,
    agentId: conversation.agent_id,
    title: conversation.title,
  });
  const requestId = tracked.id;
  if (!conversation.requestId || conversation.requestId !== requestId || !conversation.requestRole) {
    await db.saveConvo(
      { userId: user.id },
      { conversationId, requestId, requestRole },
      { context: 'initialize request workspace' },
    );
    conversation.requestId = requestId;
    conversation.requestRole = requestRole;
  }
  const threads = await db.getRequestConversations({
    requestId,
    tenantId: user.tenantId,
  });
  if (!threads.some((thread) => thread.conversationId === conversationId && String(thread.user) === user.id)) {
    throw new Error('You are not a participant in this request.');
  }
  return { user, conversation, requestId, threads, summary: tracked.summary || '' };
}

async function syncTrackedChat(req, chat) {
  const config = req?.config?.requestTracker;
  if (config?.enabled !== true) {
    throw new Error('Request tracking is not available. Please contact the platform administrator.');
  }
  const tracked = await resolveRequestChat(config, process.env.CONTROL_PLANE_TOKEN, {
    ...chat,
    tenantId: req.user?.tenantId || 'default',
    deploymentId: config.deploymentId || 'local',
  });
  if (!tracked?.id) {
    throw new Error('The request tracker did not return a request ID. Please retry or contact the platform administrator.');
  }
  if (chat.requestId && tracked.id !== chat.requestId) {
    throw new Error('The request tracker returned a different request ID. This chat could not be linked to the request.');
  }
  return tracked;
}

async function recoverReviewContext({ user, conversation, conversationId, messages = [] }) {
  const shareIds = (messages || []).flatMap((message) =>
    [...getMessageText(message.text).matchAll(/\/share\/([A-Za-z0-9_-]+)/g)].map((match) => match[1]),
  );
  for (const shareId of shareIds) {
    const share = await db.getSharedLinkByShareId(shareId);
    if (!share) continue;
    const [owner] = await db.findUsers(
      { _id: share.user, ...(user.tenantId ? { tenantId: user.tenantId } : {}) },
      '_id tenantId',
      { limit: 1 },
    );
    if (!owner || owner.tenantId !== user.tenantId) continue;
    const source = await db.getConvo(share.user, share.conversationId);
    if (!source?.requestId || source.requestRole !== 'requester') continue;
    await db.saveConvo(
      { userId: user.id },
      { conversationId, requestId: source.requestId, requestRole: 'approver' },
      { context: 'recover request review chat' },
    );
    const repaired = await db.getConvo(user.id, conversationId);
    if (repaired?.requestId === source.requestId && repaired.requestRole === 'approver') {
      conversation.requestId = source.requestId;
      conversation.requestRole = 'approver';
      return;
    }
  }
}

async function ensureRequestThreadShares({ req, threads, participantIds, requestId }) {
  const viewerRole = await db.findRoleByIdentifier(AccessRoleIds.SHARED_LINK_VIEWER);
  if (!viewerRole) throw new Error('The shared-link viewer permission role is not configured.');
  const result = [];
  const baseUrl = (process.env.DOMAIN_CLIENT || 'http://localhost:3080').replace(/\/$/, '');
  const participants = await db.findUsers(
    { _id: { $in: threads.map((thread) => thread.user) } },
    '_id email name',
    { limit: threads.length },
  );
  const participantsById = new Map(participants.map((person) => [String(person._id), person]));
  for (const thread of threads) {
    const ownerId = String(thread.user);
    const participant = participantsById.get(ownerId);
    const displayName = participant?.name || participant?.email || thread.requestRole || 'participant';
    const conversationId = thread.conversationId;
    const preflight = createShareContentPreflight(req.config?.filters, {
      snapshotFiles: false,
      user: { ...req.user, id: ownerId },
      getFiles: db.getFiles,
      sharedFileMetadata: true,
      sharedFileMetadataFiles: false,
      legacyPii: req.config?.messageFilter?.pii,
    });
    let share = await db.getSharedLink(ownerId, conversationId);
    let shareId = share?.shareId;
    let shareObjectId = share?._id;
    if (!shareId) {
      const created = await db.createSharedLink(
        ownerId,
        conversationId,
        undefined,
        undefined,
        false,
        ...(preflight == null ? [] : [preflight]),
      );
      await grantCreationPermissions(created._id, ownerId, false);
      shareId = created.shareId;
      shareObjectId = created._id;
    } else {
      const [latestMessage] = await db.getMessages(
        { user: ownerId, conversationId },
        'messageId',
        { limit: 1, sort: { createdAt: -1 } },
      );
      await db.updateSharedLink(
        ownerId,
        shareId,
        latestMessage?.messageId,
        undefined,
        false,
        preflight,
      );
    }
    for (const viewerId of participantIds) {
      if (viewerId === ownerId) continue;
      await db.grantPermission(
        PrincipalType.USER,
        viewerId,
        ResourceType.SHARED_LINK,
        shareObjectId,
        viewerRole.permBits,
        ownerId,
        undefined,
        viewerRole._id,
      );
    }
    result.push({
      conversationId,
      role: thread.requestRole,
      label: thread.requestRole === 'requester'
        ? `Request started by ${displayName}`
        : `Thread to ${displayName}`,
      link: `${baseUrl}/share/${shareId}`,
    });
    if (requestId) {
      await syncTrackedChat(req, {
        requestId,
        conversationId,
        userId: ownerId,
        role: thread.requestRole || 'collaborator',
        readOnlyUrl: `${baseUrl}/share/${shareId}`,
      });
    }
  }
  return result;
}

async function appendAssistantMessage({ userId, conversation, text, messageId = randomUUID() }) {
  const alreadySaved = await db.getMessages(
    { user: userId, conversationId: conversation.conversationId, messageId },
    'messageId',
    { limit: 1 },
  );
  if (alreadySaved.length > 0) return alreadySaved[0];
  const history = await db.getMessages(
    { user: userId, conversationId: conversation.conversationId },
    'messageId',
    { limit: 1, sort: { createdAt: -1 } },
  );
  const saved = await db.saveMessage(
    { userId },
    {
      conversationId: conversation.conversationId,
      messageId,
      parentMessageId: history[0]?.messageId || Constants.NO_PARENT,
      sender: 'assistant',
      text,
      isCreatedByUser: false,
      endpoint: conversation.endpoint || 'agents',
      model: conversation.model || conversation.agent_id || 'request-context',
      unfinished: false,
      error: false,
    },
    { context: 'request participant message' },
  );
  if (!saved) {
    throw new Error('Could not add the message to the participant chat.');
  }
  await db.saveConvo(
    { userId },
    { conversationId: conversation.conversationId },
    { context: 'request participant message', appendMessageIds: [saved._id] },
  );
  return saved;
}

function getMessageText(text) {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) {
    return text
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

async function relayRequestParticipantReply({ req, userId, userMessage, response }) {
  const participantConversation = req.resolvedConversation;
  const recipientId = participantConversation?.requestReplyToUserId;
  const recipientConversationId = participantConversation?.requestReplyToConversationId;
  const requestId = participantConversation?.requestId;
  if (!recipientId || !recipientConversationId || !requestId || !userMessage?.messageId) return;

  const recipientConversation = await db.getConvo(recipientId, recipientConversationId);
  if (!recipientConversation || recipientConversation.requestId !== requestId) {
    throw new Error('The linked request conversation could not be verified.');
  }
  const messageId = stableUUID(
    `request-reply:${requestId}:${req.body.conversationId}:${userMessage.messageId}`,
  );
  const existing = await db.getMessages(
    { user: recipientId, conversationId: recipientConversationId, messageId },
    'messageId',
    { limit: 1 },
  );
  if (existing.length > 0) return;

  const participant = req.user?.name || req.user?.email || userId;
  const participantText = getMessageText(userMessage.text).trim();
  const agentText = getMessageText(response?.text).trim();
  const text = [
    `Update from ${participant}:`,
    participantText || '(No text answer provided.)',
    ...(agentText ? ['', 'Agent follow-up:', agentText] : []),
  ].join('\n');
  const previous = await db.getMessages(
    { user: recipientId, conversationId: recipientConversationId },
    'messageId',
    { limit: 1, sort: { createdAt: -1 } },
  );
  const saved = await db.saveMessage(
    { userId: recipientId },
    {
      conversationId: recipientConversationId,
      messageId,
      parentMessageId: previous[0]?.messageId || Constants.NO_PARENT,
      sender: 'assistant',
      text,
      isCreatedByUser: false,
      endpoint: recipientConversation.endpoint || 'agents',
      model: participantConversation.model || participantConversation.agent_id || 'request-thread',
      unfinished: false,
      error: false,
    },
    { context: 'relay request participant reply' },
  );
  if (!saved) throw new Error('Could not relay the participant reply to the linked request chat.');
  await db.saveConvo(
    { userId: recipientId },
    { conversationId: recipientConversationId },
    { context: 'relay request participant reply', appendMessageIds: [saved._id] },
  );
  const threads = await db.getRequestConversations({ requestId, tenantId: req.user?.tenantId });
  await ensureRequestThreadShares({
    req,
    threads,
    requestId,
    participantIds: [...new Set(threads.map((thread) => String(thread.user)))],
  });
}

function createRequestThreadTools({ req, agentId }) {
  const messageParticipant = new DynamicStructuredTool({
    name: 'message_request_participant',
    description:
      'Send a question or a concise update to a participant in this request. It reuses that participant’s single 1:1 chat for this request, creating it only if needed. When a participant answers a routed question, send a concise summary to the person who needs that answer. The same agent and model are retained.',
    schema: z.object({
      email: z.string().email().describe('Email of the request participant to message.'),
      message: z.string().min(1).max(4000).describe('Question or concise update to send.'),
      role: z.enum(['approver', 'collaborator']).optional().describe('Role for a new participant thread.'),
    }),
    func: async ({ email, message, role }) => {
      const request = await loadRequestContext(req);
      const normalizedEmail = email.trim().toLowerCase();
      const [target] = await db.findUsers(
        { email: normalizedEmail, ...(request.user.tenantId ? { tenantId: request.user.tenantId } : {}) },
        '_id email name role tenantId',
        { limit: 1 },
      );
      if (!target) {
        throw new Error('That user could not be found in your organization.');
      }
      const targetId = String(target._id);
      if (targetId === request.user.id) {
        throw new Error('Choose another participant in this request.');
      }
      const targetReq = { ...req, user: { ...target, id: targetId } };
      const canUseAgent = await createAgentAccessCheck(targetReq)({
        agentId: request.conversation.agent_id || agentId,
        endpoint: request.conversation.endpoint || 'agents',
      });
      if (!canUseAgent) {
        throw new Error('The participant does not have access to this agent. Ask an agent administrator to grant access.');
      }
      const targetThread = request.threads.find((thread) => String(thread.user) === targetId);
      const targetConversationId =
        targetThread?.conversationId || stableUUID(`request-thread:${request.requestId}:${targetId}`);
      let targetConversation = targetThread
        ? await db.getConvo(targetId, targetConversationId)
        : null;
      if (!targetConversation) {
        targetConversation = await db.saveConvo(
          { userId: targetId },
          {
            conversationId: targetConversationId,
            title: request.conversation.title || 'Request discussion',
            endpoint: request.conversation.endpoint || 'agents',
            model: request.conversation.model,
            agent_id: request.conversation.agent_id || agentId,
            requestId: request.requestId,
            requestRole: role || 'collaborator',
            requestReplyToConversationId: request.conversation.conversationId,
            requestReplyToUserId: request.user.id,
          },
          { context: 'create request participant chat' },
        );
      }
      if (!targetConversation) {
        throw new Error('Could not create or open the participant chat.');
      }
      if (targetConversation.requestReplyToConversationId !== request.conversation.conversationId ||
          targetConversation.requestReplyToUserId !== request.user.id) {
        targetConversation = await db.saveConvo(
          { userId: targetId },
          {
            conversationId: targetConversationId,
            requestId: request.requestId,
            requestRole: targetConversation.requestRole || role || 'collaborator',
            requestReplyToConversationId: request.conversation.conversationId,
            requestReplyToUserId: request.user.id,
          },
          { context: 'route request participant reply' },
        );
      }
      const linkedConversation = await db.getConvo(targetId, targetConversationId);
      if (
        !linkedConversation ||
        linkedConversation.requestId !== request.requestId ||
        linkedConversation.requestReplyToConversationId !== request.conversation.conversationId ||
        linkedConversation.requestReplyToUserId !== request.user.id
      ) {
        throw new Error('The participant chat could not be linked to this request.');
      }
      await syncTrackedChat(req, {
        requestId: request.requestId,
        conversationId: targetConversationId,
        userId: targetId,
        email: target.email,
        name: target.name,
        role: targetConversation.requestRole || role || 'collaborator',
        agentId: targetConversation.agent_id || request.conversation.agent_id || agentId,
        title: targetConversation.title || request.conversation.title,
      });
      const allThreads = [
        ...request.threads.filter((thread) => thread.conversationId !== targetConversationId),
        {
          conversationId: targetConversationId,
          user: targetId,
          requestRole: targetConversation.requestRole || role || 'collaborator',
        },
      ];
      const participantIds = [...new Set(allThreads.map((thread) => String(thread.user)))];
      const contextThreads = allThreads.filter((thread) => thread.conversationId !== targetConversationId);
      const contextShares = await ensureRequestThreadShares({
        req,
        threads: contextThreads,
        requestId: request.requestId,
        participantIds: [...new Set([...participantIds, targetId])],
      });
      const contextLinks = contextShares
        .map((thread) => `- ${thread.label || `Thread to ${thread.role || 'participant'}`}: ${thread.link}`)
        .join('\n');
      const priorMessages = await db.getMessages(
        { user: targetId, conversationId: targetConversationId },
        'text',
        { limit: 50, sort: { createdAt: 1 } },
      );
      const hasRequestBackground = priorMessages.some((item) =>
        /Request background:/i.test(getMessageText(item.text)),
      );
      const requestSummary = (request.summary || '').trim();
      const clippedSummary = requestSummary.length > 3500
        ? `${requestSummary.slice(0, 3500).trimEnd()}\n[Summary shortened; see the linked requester thread for full context.]`
        : requestSummary;
      const messageWithContext = [
        ...(!hasRequestBackground && clippedSummary
          ? ['Request background:', clippedSummary, '']
          : []),
        message.trim(),
        ...(contextLinks ? ['', 'Other request threads (read-only):', contextLinks] : []),
      ].join('\n');
      await appendAssistantMessage({ userId: targetId, conversation: targetConversation, text: messageWithContext });
      const link = `${(process.env.DOMAIN_CLIENT || 'http://localhost:3080').replace(/\/$/, '')}/c/${targetConversationId}`;
      const sharedThreads = await ensureRequestThreadShares({
        req,
        threads: allThreads,
        requestId: request.requestId,
        participantIds,
      });
      return JSON.stringify({
        status: 'sent',
        recipient: target.email,
        conversationId: targetConversationId,
        link,
        sharedThreads,
        message: 'The message was added to the participant’s request chat.',
      });
    },
  });

  const getRequestContext = new DynamicStructuredTool({
    name: 'get_request_context',
    description:
      'Retrieve recent messages from the 1:1 chats linked to this request when another participant’s context is needed. Only threads linked to the current request are returned. Summarize relevant facts with the participant and thread identified.',
    schema: z.object({
      query: z.string().min(1).max(1000).describe('What information to look for across request chats.'),
    }),
    func: async ({ query }) => {
      const request = await loadRequestContext(req);
      const users = await db.findUsers(
        { _id: { $in: request.threads.map((thread) => thread.user) } },
        '_id email name',
        { limit: request.threads.length },
      );
      const usersById = new Map(users.map((user) => [String(user._id), user]));
      const results = await Promise.all(
        request.threads.map(async (thread) => {
          const messages = await db.getMessages(
            { user: thread.user, conversationId: thread.conversationId, isCreatedByUser: { $in: [true, false] } },
            'sender text createdAt isCreatedByUser',
            { limit: 16, sort: { createdAt: -1 } },
          );
          const participant = usersById.get(thread.user);
          return {
            participant: participant?.name || participant?.email || thread.user,
            email: participant?.email || '',
            role: thread.requestRole || 'collaborator',
            conversationId: thread.conversationId,
            messages: messages.reverse().map((item) => ({
              sender: item.isCreatedByUser ? 'participant' : 'agent',
              text: (item.text || '').slice(0, 2500),
              createdAt: item.createdAt,
            })),
          };
        }),
      );
      return JSON.stringify({
        query,
        requestId: request.requestId,
        summary: request.summary,
        threads: results,
      });
    },
  });

  return [messageParticipant, getRequestContext];
}

module.exports = {
  createRequestThreadTools,
  loadRequestContext,
  syncTrackedChat,
  appendAssistantMessage,
  relayRequestParticipantReply,
  recoverReviewContext,
  ensureRequestThreadShares,
  stableUUID,
};
