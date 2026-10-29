const express = require('express');
const { createUserPreferencesHandler } = require('@librechat/api');
const {
  updateUserPluginsController,
  resendVerificationController,
  getTermsStatusController,
  acceptTermsController,
  verifyEmailController,
  deleteUserController,
  getUserController,
} = require('~/server/controllers/UserController');
const {
  verifyEmailLimiter,
  verifyEmailSubmissionLimiter,
  configMiddleware,
  canDeleteAccount,
  requireJwtAuth,
} = require('~/server/middleware');

const settings = require('./settings');
const { updateUserStatefulCodeEnvironment, searchPrincipals } = require('~/models');
const { PrincipalType } = require('librechat-data-provider');
const logger = require('~/utils/logger');

const router = express.Router();

const updateUserPreferences = createUserPreferencesHandler({
  updateStatefulCodeEnvironment: updateUserStatefulCodeEnvironment,
});

router.use('/settings', settings);
router.get('/', requireJwtAuth, getUserController);
router.get('/mentions', requireJwtAuth, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (query.length < 3) {
    return res.status(200).json({ results: [] });
  }
  try {
    const results = await searchPrincipals(query, 10, [PrincipalType.USER]);
    return res.status(200).json({
      results: results
        .filter((person) => person.type === PrincipalType.USER && person.id)
        .map(({ id, name, username, avatar }) => ({
          id,
          name: name || username || 'Unknown user',
          avatar,
        })),
    });
  } catch (error) {
    logger.error('[user/mentions] failed to search users', error);
    return res.status(500).json({ error: 'Unable to search people' });
  }
});
router.patch('/preferences', requireJwtAuth, configMiddleware, updateUserPreferences);
router.get('/terms', requireJwtAuth, getTermsStatusController);
router.post('/terms/accept', requireJwtAuth, acceptTermsController);
router.post('/plugins', requireJwtAuth, updateUserPluginsController);
router.delete('/delete', requireJwtAuth, canDeleteAccount, configMiddleware, deleteUserController);
router.post('/verify', verifyEmailSubmissionLimiter, verifyEmailController);
router.post('/verify/resend', verifyEmailLimiter, resendVerificationController);

module.exports = router;
