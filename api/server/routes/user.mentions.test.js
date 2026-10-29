const express = require('express');
const request = require('supertest');
const { PrincipalType } = require('librechat-data-provider');

jest.mock('~/server/controllers/UserController', () => ({
  getUserController: jest.fn(),
  deleteUserController: jest.fn(),
  acceptTermsController: jest.fn(),
  verifyEmailController: jest.fn(),
  getTermsStatusController: jest.fn(),
  updateUserPluginsController: jest.fn(),
  resendVerificationController: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  canDeleteAccount: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
  verifyEmailLimiter: (req, res, next) => next(),
  verifyEmailSubmissionLimiter: (req, res, next) => next(),
}));

jest.mock('~/models', () => ({
  searchPrincipals: jest.fn(),
}));

jest.mock('./settings', () => require('express').Router());

const { searchPrincipals } = require('~/models');
const userRouter = require('./user');

describe('GET /api/user/mentions', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use('/api/user', userRouter);
  });

  it('does not query the directory until the prefix has three characters', async () => {
    await request(app).get('/api/user/mentions?q=al').expect(200, { results: [] });
    expect(searchPrincipals).not.toHaveBeenCalled();
  });

  it('returns only local user identity fields, never emails', async () => {
    searchPrincipals.mockResolvedValue([
      {
        id: '0123456789abcdef01234567',
        name: 'Alex User',
        email: 'alex@example.test',
        avatar: 'avatar.png',
        type: PrincipalType.USER,
      },
      { id: null, name: 'Remote User', email: 'remote@example.test', type: PrincipalType.USER },
      { id: 'group-id', name: 'A Group', type: 'GROUP' },
    ]);

    const response = await request(app).get('/api/user/mentions?q=ale').expect(200);
    expect(searchPrincipals).toHaveBeenCalledWith('ale', 10, [PrincipalType.USER]);
    expect(response.body).toEqual({
      results: [{ id: '0123456789abcdef01234567', name: 'Alex User', avatar: 'avatar.png' }],
    });
  });
});
