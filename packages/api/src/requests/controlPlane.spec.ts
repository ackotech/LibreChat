import {
  RequestTrackerUnavailableError,
  resolveRequestChat,
} from './controlPlane';

describe('request tracker client configuration', () => {
  it('does not make a request when its base URL is empty', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(
      resolveRequestChat(
        { enabled: true, baseUrl: '', deploymentId: 'test' },
        'service-token',
        {
          tenantId: 'tenant',
          deploymentId: 'test',
          conversationId: 'conversation',
          userId: 'user',
          role: 'requester',
        },
      ),
    ).rejects.toBeInstanceOf(RequestTrackerUnavailableError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not make a request when its base URL is missing', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(
      resolveRequestChat({ enabled: true, deploymentId: 'test' }, 'service-token', {
        tenantId: 'tenant',
        deploymentId: 'test',
        conversationId: 'conversation',
        userId: 'user',
        role: 'requester',
      }),
    ).rejects.toBeInstanceOf(RequestTrackerUnavailableError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
