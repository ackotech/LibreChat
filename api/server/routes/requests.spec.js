const express = require('express');
const supertest = require('supertest');

const mockGetTrackedRequest = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  getTrackedRequest: (...args) => mockGetTrackedRequest(...args),
}));
jest.mock('~/server/middleware/requireJwtAuth', () => (_req, _res, next) => next());
jest.mock('~/server/middleware', () => ({
  configMiddleware: (req, _res, next) => {
    req.config = { requestTracker: { enabled: true } };
    next();
  },
}));
jest.mock('~/models', () => ({
  getMessages: jest.fn(),
}));

const db = require('~/models');
const router = require('./requests');

function createApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'requester-id', tenantId: 'tenant-a' };
    next();
  });
  app.use('/api/requests', router);
  return app;
}

describe('GET /:requestId/chats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTrackedRequest.mockResolvedValue({
      id: 'request-1',
      chats: [
        {
          conversationId: 'requester-thread',
          userId: 'requester-id',
          name: 'Karthikeyan',
          role: 'requester',
        },
        {
          conversationId: 'reviewer-thread',
          userId: 'reviewer-id',
          name: 'Security Reviewer',
          role: 'approver',
        },
      ],
    });
    db.getMessages.mockImplementation(async ({ conversationId }) => [
      {
        messageId: `${conversationId}-message`,
        sender: 'participant',
        text: `message from ${conversationId}`,
        isCreatedByUser: true,
        createdAt: '2026-10-28T00:01:00.000Z',
      },
    ]);
  });

  it('loads transcripts from the tracker-linked conversations, independent of local requestId tags', async () => {
    const response = await supertest(createApp()).get('/api/requests/request-1/chats');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body.map(({ conversationId, role }) => [conversationId, role])).toEqual([
      ['requester-thread', 'requester'],
      ['reviewer-thread', 'approver'],
    ]);
    expect(db.getMessages).toHaveBeenCalledTimes(2);
    expect(db.getMessages).toHaveBeenCalledWith(
      { conversationId: 'reviewer-thread', user: 'reviewer-id' },
      expect.anything(),
      { sort: { createdAt: -1 }, limit: 201 },
    );
  });
});
