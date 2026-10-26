const express = require('express');
const { CLIENT_MESSAGE_SELECT } = require('@librechat/data-schemas');
const {
  RequestTrackerUnavailableError,
  RequestTrackerNotFoundError,
  getTrackedRequest,
  listTrackedRequests,
} = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { configMiddleware } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
router.use(requireJwtAuth, configMiddleware);

function getIdentity(req) {
  return {
    tenantId: req.user?.tenantId || 'default',
    userId: req.user?.id,
  };
}

function getConfig(req, res) {
  const config = req.config?.requestTracker;
  if (config?.enabled !== true) {
    res.status(503).json({ errorCode: 'request_tracker_disabled' });
    return null;
  }
  return config;
}

function handleFailure(res, error) {
  if (error instanceof RequestTrackerNotFoundError) {
    res.status(404).json({ errorCode: error.code });
    return;
  }
  if (error instanceof RequestTrackerUnavailableError) {
    res.status(503).json({ errorCode: error.code });
    return;
  }
  res.status(502).json({ errorCode: 'request_tracker_unavailable' });
}

router.get('/', async (req, res) => {
  const config = getConfig(req, res);
  if (!config) return;
  const { tenantId, userId } = getIdentity(req);
  if (!userId) return res.status(401).json({ errorCode: 'unauthorized' });
  try {
    const requests = await listTrackedRequests(
      config,
      process.env.CONTROL_PLANE_TOKEN,
      tenantId,
      userId,
    );
    return res.status(200).json(requests);
  } catch (error) {
    return handleFailure(res, error);
  }
});

router.get('/:requestId', async (req, res) => {
  const config = getConfig(req, res);
  if (!config) return;
  const { tenantId, userId } = getIdentity(req);
  if (!userId) return res.status(401).json({ errorCode: 'unauthorized' });
  try {
    const request = await getTrackedRequest(
      config,
      process.env.CONTROL_PLANE_TOKEN,
      req.params.requestId,
      tenantId,
      userId,
    );
    return res.status(200).json(request);
  } catch (error) {
    return handleFailure(res, error);
  }
});

router.get('/:requestId/chats', async (req, res) => {
  const config = getConfig(req, res);
  if (!config) return;
  const { tenantId, userId } = getIdentity(req);
  if (!userId) return res.status(401).json({ errorCode: 'unauthorized' });

  try {
    // This call also enforces that the caller is a member of the tracked request.
    const request = await getTrackedRequest(
      config,
      process.env.CONTROL_PLANE_TOKEN,
      req.params.requestId,
      tenantId,
      userId,
    );
    const linked = await db.getRequestConversations({ requestId: request.id, tenantId });
    const allowedChats = new Map(
      request.chats.map((chat) => [`${chat.userId}:${chat.conversationId}`, chat]),
    );
    const maxMessagesPerChat = 200;

    const chats = await Promise.all(
      linked.map(async (thread) => {
        const ownerId = String(thread.user);
        const chat = allowedChats.get(`${ownerId}:${thread.conversationId}`);
        if (!chat) return null;

        const rows = await db.getMessages(
          { conversationId: thread.conversationId, user: ownerId },
          CLIENT_MESSAGE_SELECT,
          { sort: { createdAt: -1 }, limit: maxMessagesPerChat + 1 },
        );
        const truncated = rows.length > maxMessagesPerChat;
        const messages = rows
          .slice(0, maxMessagesPerChat)
          .reverse()
          .map((message) => ({
            messageId: message.messageId,
            sender: message.sender,
            text: typeof message.text === 'string' ? message.text : '',
            isCreatedByUser: Boolean(message.isCreatedByUser),
            createdAt: message.createdAt,
          }));

        return {
          conversationId: thread.conversationId,
          userId: ownerId,
          title: thread.title || chat.name || 'Chat',
          role: chat.role,
          messages,
          truncated,
        };
      }),
    );

    return res.status(200).json(chats.filter(Boolean));
  } catch (error) {
    return handleFailure(res, error);
  }
});

module.exports = router;
