const { DynamicStructuredTool } = require('@librechat/agents/langchain/tools');
const { z } = require('zod');
const { PrincipalType } = require('librechat-data-provider');
const db = require('~/models');

const MAX_MENTIONS = 10;

function createMentionedPeopleTool({ req }) {
  return new DynamicStructuredTool({
    name: 'get_mentioned_people',
    description:
      'Resolve people explicitly selected with @ in the current user message. This only returns identities; it does not contact them or create a chat. Decide from the conversation whether the user is merely referencing someone or is asking for approval/help.',
    schema: z.object({}),
    func: async () => {
      const selected = req?.body?.requestMentions;
      if (!Array.isArray(selected) || selected.length === 0) {
        return 'No people were selected with @ in the current message.';
      }
      if (selected.length > MAX_MENTIONS) {
        throw new Error(`At most ${MAX_MENTIONS} people can be resolved in one message.`);
      }

      const validSelections = selected
        .filter(
          ({ id, name }) =>
            typeof id === 'string' && /^[a-f\d]{24}$/i.test(id) && typeof name === 'string',
        )
        .slice(0, MAX_MENTIONS);
      const people = await Promise.all(
        validSelections.map(async ({ id, name }) => {
          const matches = await db.searchPrincipals(name, 10, [PrincipalType.USER]);
          if (!matches.some((person) => person.id === id && person.type === PrincipalType.USER)) {
            return null;
          }
          return db.findUser({ _id: id }, 'name email username');
        }),
      );
      return JSON.stringify(
        people.filter(Boolean).map((person) => ({
          id: person._id?.toString(),
          name: person.name || person.username || person.email,
          email: person.email,
        })),
      );
    },
  });
}

module.exports = { createMentionedPeopleTool };
