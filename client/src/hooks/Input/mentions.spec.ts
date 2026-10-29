import {
  formatPersonMention,
  getMentionQueryContext,
  getPersonMentionQueryContext,
  insertPersonMentionAtCursor,
  mergeRequestMentions,
  MIN_PERSON_MENTION_QUERY_LENGTH,
  shouldSearchPeople,
  isPartialPersonMentionPrefix,
  isPersonMentionSearchPrefix,
} from './mentions';

describe('person mentions', () => {
  it('waits for a short prefix before searching the directory', () => {
    expect(MIN_PERSON_MENTION_QUERY_LENGTH).toBe(3);
    expect(shouldSearchPeople('ka')).toBe(false);
    expect(shouldSearchPeople('kar')).toBe(true);
  });

  it('formats a visible display-name mention without exposing the directory ID', () => {
    expect(formatPersonMention('Karthikeyan User')).toBe('@person Karthikeyan User');
  });

  it('recognizes the explicit @person query without changing normal @ parsing', () => {
    const text = 'Please ask @person ali to review';
    expect(getPersonMentionQueryContext(text, text.indexOf(' to review'))).toEqual({
      start: 'Please ask '.length,
      query: 'ali',
    });
    expect(getPersonMentionQueryContext('Use @gpt-4 for this', 11)).toBeUndefined();
    expect(isPartialPersonMentionPrefix('Please ask @pers', 'Please ask @pers'.length)).toBe(true);
    expect(isPartialPersonMentionPrefix('Please ask @person ', 'Please ask @person '.length)).toBe(
      false,
    );
    expect(isPersonMentionSearchPrefix('p')).toBe(true);
    expect(isPersonMentionSearchPrefix('pers')).toBe(true);
    expect(isPersonMentionSearchPrefix('person')).toBe(true);
    expect(isPersonMentionSearchPrefix('python')).toBe(false);
  });

  it('captures a normal inline @ query and preserves both sides of the cursor', () => {
    const text = 'Please ask @ali to review';
    expect(getMentionQueryContext(text, 'Please ask @ali'.length)).toEqual({
      start: 'Please ask '.length,
      query: 'ali',
    });
    expect(
      insertPersonMentionAtCursor('Please ask  to review', 'Please ask '.length, 'Alice'),
    ).toEqual({
      text: 'Please ask @person Alice to review',
      cursor: 'Please ask @person Alice'.length,
    });
  });

  it('keeps one identity per selected person', () => {
    const alice = { id: 'user-1', name: 'Alice' };
    const mentions = mergeRequestMentions([alice], { id: 'user-1', name: 'Alice A.' });
    expect(mentions).toEqual([alice]);
  });

  it('ignores invalid identities', () => {
    expect(mergeRequestMentions([], { id: '', name: 'Alice' })).toEqual([]);
  });
});
