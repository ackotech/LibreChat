import { EModelEndpoint } from './schemas';
import type { TSubmission } from './types';
import createPayload from './createPayload';

describe('createPayload request mentions', () => {
  it('sends selected identities as request metadata rather than message fields', () => {
    const submission = {
      conversation: { conversationId: null, endpoint: EModelEndpoint.agents },
      endpointOption: { endpoint: EModelEndpoint.agents },
      userMessage: {
        messageId: 'user-message',
        conversationId: null,
        parentMessageId: null,
        responseMessageId: null,
        text: 'Ask @Alice to review.',
        isCreatedByUser: true,
      },
      isTemporary: false,
      requestMentions: [{ id: '0123456789abcdef01234567', name: 'Alice' }],
    } as TSubmission;

    const { payload } = createPayload(submission);
    expect(payload.requestMentions).toEqual([{ id: '0123456789abcdef01234567', name: 'Alice' }]);
    expect(payload).not.toHaveProperty('userMessage.requestMentions');
  });
});
