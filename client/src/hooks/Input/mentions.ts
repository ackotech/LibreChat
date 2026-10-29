import { EModelEndpoint, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';

export const MIN_PERSON_MENTION_QUERY_LENGTH = 3;

export type RequestMention = { id: string; name: string };

export function shouldSearchPeople(searchValue: string): boolean {
  return searchValue.trim().length >= MIN_PERSON_MENTION_QUERY_LENGTH;
}

export function mergeRequestMentions(
  existing: RequestMention[],
  mention: RequestMention,
): RequestMention[] {
  if (!mention.id || !mention.name || existing.some(({ id }) => id === mention.id)) {
    return existing;
  }
  return [...existing, mention];
}

export function formatPersonMention(name: string): string {
  return `@person ${name}`;
}

/** A person lookup is deliberately namespaced so normal @ model/agent selection stays intact. */
export function getPersonMentionQueryContext(text: string, cursor: number) {
  const beforeCursor = text.slice(0, cursor);
  const match = /(?:^|[\s([{,:;])@person\s+([^@\s]*)$/iu.exec(beforeCursor);
  if (!match) return undefined;
  const query = match[1];
  const start = match.index + match[0].indexOf('@');
  return { start, query };
}

/** Wait while the user is typing the reserved @person prefix, before opening the normal @ picker. */
export function isPartialPersonMentionPrefix(text: string, cursor: number): boolean {
  return /(?:^|[\s([{,:;])@(?:p(?:e(?:r(?:s(?:o(?:n)?)?)?)?)?)?$/iu.test(text.slice(0, cursor));
}

/** Identifies the reserved @person spelling while it is being entered in the @ picker. */
export function isPersonMentionSearchPrefix(searchValue: string): boolean {
  return /^p(?:e(?:r(?:s(?:o(?:n)?)?)?)?)?$/iu.test(searchValue);
}

export function getMentionQueryContext(text: string, cursor: number) {
  const beforeCursor = text.slice(0, cursor);
  const match = /(?:^|[\s([{,:;])@([^@\s]*)$/u.exec(beforeCursor);
  if (!match) return undefined;
  const tokenStart = match.index + match[0].length - match[1].length - 1;
  return { start: tokenStart, query: match[1] };
}

export function insertPersonMentionAtCursor(text: string, cursor: number, name: string) {
  const trailingSpace = /^\s/u.test(text.slice(cursor)) ? '' : ' ';
  const token = `${formatPersonMention(name)}${trailingSpace}`;
  const nextText = `${text.slice(0, cursor)}${token}${text.slice(cursor)}`;
  return { text: nextText, cursor: cursor + token.length };
}

export function filterMentionEndpoints({
  endpoints,
  includedEndpoints,
  includeAssistants,
  hasAgentAccess,
}: {
  endpoints: Array<EModelEndpoint | string>;
  includedEndpoints: Set<string>;
  includeAssistants: boolean;
  hasAgentAccess: boolean;
}) {
  const hasEndpointAllowList = includedEndpoints.size > 0;

  return endpoints.filter((endpoint) => {
    if (!includeAssistants && isAssistantsEndpoint(endpoint)) {
      return false;
    }

    if (isAgentsEndpoint(endpoint) && !hasAgentAccess) {
      return false;
    }

    if (hasEndpointAllowList && !includedEndpoints.has(endpoint)) {
      return false;
    }

    return true;
  });
}
