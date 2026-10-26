const express = require('express');
const {
  RequestTrackerUnavailableError,
  RequestTrackerNotFoundError,
  getTrackedRequest,
  listTrackedRequests,
} = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { configMiddleware } = require('~/server/middleware');

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
    const requests = await listTrackedRequests(config, process.env.CONTROL_PLANE_TOKEN, tenantId, userId);
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

module.exports = router;
