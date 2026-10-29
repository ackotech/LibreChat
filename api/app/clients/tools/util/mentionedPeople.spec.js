jest.mock('~/models', () => ({
  searchPrincipals: jest.fn(),
  findUser: jest.fn(),
}));

const db = require('~/models');
const { PrincipalType } = require('librechat-data-provider');
const { createMentionedPeopleTool } = require('./mentionedPeople');

describe('get_mentioned_people tool', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolves selected IDs to server-authoritative identities without contacting anyone', async () => {
    db.searchPrincipals.mockResolvedValue([
      { id: '0123456789abcdef01234567', type: PrincipalType.USER },
    ]);
    db.findUser.mockResolvedValue({
      _id: '0123456789abcdef01234567',
      name: 'A Person',
      email: 'person@example.test',
    });
    const tool = createMentionedPeopleTool({
      req: {
        user: { id: 'requester', role: 'USER' },
        body: { requestMentions: [{ id: '0123456789abcdef01234567', name: 'A Person' }] },
      },
    });

    await expect(tool.invoke({})).resolves.toContain('person@example.test');
    expect(db.findUser).toHaveBeenCalledWith(
      { _id: '0123456789abcdef01234567' },
      'name email username',
    );
  });

  it('does not resolve identities that are not in the user mention directory', async () => {
    db.searchPrincipals.mockResolvedValue([]);
    const tool = createMentionedPeopleTool({
      req: {
        user: { id: 'requester', role: 'USER' },
        body: { requestMentions: [{ id: '0123456789abcdef01234567', name: 'A Person' }] },
      },
    });

    await expect(tool.invoke({})).resolves.toBe('[]');
    expect(db.findUser).not.toHaveBeenCalled();
  });

  it('returns an empty result when the message has no selected people', async () => {
    const tool = createMentionedPeopleTool({ req: { body: {} } });
    await expect(tool.invoke({})).resolves.toContain('No people were selected');
    expect(db.searchPrincipals).not.toHaveBeenCalled();
  });
});
