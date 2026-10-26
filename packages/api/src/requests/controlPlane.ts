import type { TRequestChat, TTrackedRequest } from 'librechat-data-provider';

export interface RequestTrackerConfig {
  enabled: boolean;
  baseUrl?: string;
  deploymentId: string;
}

export type TrackedChat = TRequestChat;
export type TrackedRequest = TTrackedRequest;

export type ResolveRequestChatInput = {
  requestId?: string;
  tenantId: string;
  deploymentId: string;
  conversationId: string;
  userId: string;
  email?: string;
  name?: string;
  role: TrackedChat['role'];
  agentId?: string;
  title?: string;
  readOnlyUrl?: string;
};

export class RequestTrackerUnavailableError extends Error {
  readonly code = 'request_tracker_unavailable';

  constructor() {
    super('Request tracking is temporarily unavailable. Please retry or contact the platform administrator.');
    this.name = 'RequestTrackerUnavailableError';
  }
}

export class RequestTrackerNotFoundError extends Error {
  readonly code = 'request_not_found';

  constructor() {
    super('The requested item could not be found.');
    this.name = 'RequestTrackerNotFoundError';
  }
}

async function requestTrackerFetch<T>(
  config: RequestTrackerConfig,
  token: string | undefined,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!config.enabled) {
    throw new RequestTrackerUnavailableError();
  }
  if (!config.baseUrl || !token) {
    throw new RequestTrackerUnavailableError();
  }

  try {
    const response = await fetch(new URL(path, `${config.baseUrl.replace(/\/+$/, '')}/`), {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new RequestTrackerNotFoundError();
      }
      throw new RequestTrackerUnavailableError();
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof RequestTrackerNotFoundError) {
      throw error;
    }
    throw new RequestTrackerUnavailableError();
  }
}

export function resolveRequestChat(
  config: RequestTrackerConfig,
  token: string | undefined,
  input: ResolveRequestChatInput,
): Promise<TrackedRequest> {
  return requestTrackerFetch<TrackedRequest>(config, token, '/v1/chats/resolve', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getTrackedRequest(
  config: RequestTrackerConfig,
  token: string | undefined,
  requestId: string,
  tenantId: string,
  userId: string,
): Promise<TrackedRequest> {
  const query = new URLSearchParams({ tenantId, userId, deploymentId: config.deploymentId });
  return requestTrackerFetch<TrackedRequest>(
    config,
    token,
    `/v1/requests/${encodeURIComponent(requestId)}?${query.toString()}`,
  );
}

export function listTrackedRequests(
  config: RequestTrackerConfig,
  token: string | undefined,
  tenantId: string,
  userId: string,
): Promise<TrackedRequest[]> {
  const query = new URLSearchParams({ tenantId, userId, deploymentId: config.deploymentId });
  return requestTrackerFetch<TrackedRequest[]>(config, token, `/v1/requests?${query.toString()}`);
}

export function updateTrackedRequest(
  config: RequestTrackerConfig,
  token: string | undefined,
  requestId: string,
  tenantId: string,
  userId: string,
  update: {
    title?: string;
    summary?: string;
    status?: TrackedRequest['status'];
    conditions?: string[];
    validUntil?: string;
  },
): Promise<TrackedRequest> {
  const query = new URLSearchParams({ tenantId, userId, deploymentId: config.deploymentId });
  return requestTrackerFetch<TrackedRequest>(
    config,
    token,
    `/v1/requests/${encodeURIComponent(requestId)}?${query.toString()}`,
    { method: 'PATCH', body: JSON.stringify(update) },
  );
}
