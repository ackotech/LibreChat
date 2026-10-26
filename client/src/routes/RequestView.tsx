import { useEffect, useState, type FormEvent } from 'react';
import { Button, Spinner } from '@librechat/client';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { TTrackedRequest } from 'librechat-data-provider';
import {
  useTrackedRequestChatsQuery,
  useTrackedRequestQuery,
  useTrackedRequestsQuery,
} from '~/data-provider';
import { useAuthContext, useLocalize } from '~/hooks';

function RequestCard({ request }: { request: TTrackedRequest }) {
  const localize = useLocalize();
  return (
    <Link
      to={`/requests/${encodeURIComponent(request.id)}`}
      className="block rounded-xl border border-border-medium bg-surface-primary p-4 text-text-primary hover:bg-surface-hover"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{request.title}</h2>
        <span className="rounded-full bg-surface-secondary px-2 py-1 text-xs">
          {localize(`com_ui_request_status_${request.status}` as never)}
        </span>
      </div>
      <p className="mt-2 break-all font-mono text-xs text-text-secondary">{request.id}</p>
      <p className="mt-2 text-sm text-text-secondary">
        {localize('com_ui_request_chat_count', { count: request.chats.length })}
      </p>
    </Link>
  );
}

function RequestDetails({ request }: { request: TTrackedRequest }) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const transcriptsQuery = useTrackedRequestChatsQuery(request.id);
  const latestApproval = request.approvals?.[request.approvals.length - 1];
  return (
    <>
      <div className="rounded-xl border border-border-medium bg-surface-primary p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-text-primary">{request.title}</h1>
            <p className="mt-2 break-all font-mono text-sm text-text-secondary">{request.id}</p>
          </div>
          <span className="rounded-full bg-surface-secondary px-3 py-1 text-sm text-text-primary">
            {localize(`com_ui_request_status_${request.status}` as never)}
          </span>
        </div>
        {request.summary && (
          <p className="mt-5 whitespace-pre-wrap text-sm text-text-primary">{request.summary}</p>
        )}
        {latestApproval && (
          <div className="mt-5 rounded-lg border border-border-medium bg-surface-secondary p-4">
            <p className="font-medium text-text-primary">
              {localize(`com_ui_request_status_${latestApproval.decision}` as never)}
            </p>
            {latestApproval.conditions?.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">
                {latestApproval.conditions.map((condition) => (
                  <li key={condition}>{condition}</li>
                ))}
              </ul>
            ) : null}
            {latestApproval.validUntil && (
              <p className="mt-2 text-sm text-text-secondary">
                {localize('com_ui_request_valid_until', {
                  date: new Date(latestApproval.validUntil).toLocaleString(),
                })}
              </p>
            )}
          </div>
        )}
        <p className="mt-5 text-sm text-text-secondary">
          {localize('com_ui_request_updated', {
            date: new Date(request.updatedAt).toLocaleString(),
          })}
        </p>
      </div>

      <section className="mt-6" aria-labelledby="request-chats-heading">
        <h2 id="request-chats-heading" className="mb-3 text-lg font-semibold text-text-primary">
          {localize('com_ui_request_chats')}
        </h2>
        <ul className="space-y-3">
          {request.chats.map((chat) => (
            <li
              key={`${chat.userId}:${chat.conversationId}`}
              className="rounded-xl border border-border-medium bg-surface-primary p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-text-primary">
                    {chat.name || chat.email || localize('com_ui_request_participant')}
                  </p>
                  <p className="mt-1 text-sm text-text-secondary">
                    {localize(`com_ui_request_role_${chat.role}` as never)}
                  </p>
                </div>
                {chat.readOnlyUrl ? (
                  <a
                    href={chat.readOnlyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-text-primary underline underline-offset-4"
                  >
                    {localize('com_ui_request_open_read_only_chat')}
                  </a>
                ) : chat.userId === user?.id ? (
                  <Link
                    to={`/c/${encodeURIComponent(chat.conversationId)}`}
                    className="text-sm font-medium text-text-primary underline underline-offset-4"
                  >
                    {localize('com_ui_request_open_chat')}
                  </Link>
                ) : (
                  <span className="text-sm text-text-secondary">
                    {localize('com_ui_request_chat_not_shared')}
                  </span>
                )}
              </div>
              {transcriptsQuery.isLoading ? (
                <div className="mt-4 flex justify-center py-4">
                  <Spinner />
                </div>
              ) : transcriptsQuery.isError ? (
                <p role="alert" className="mt-4 text-sm text-text-secondary">
                  {localize('com_ui_request_transcripts_failed')}
                </p>
              ) : (
                (() => {
                  const transcript = transcriptsQuery.data?.find(
                    (item) =>
                      item.conversationId === chat.conversationId && item.userId === chat.userId,
                  );
                  if (!transcript) return null;
                  return (
                    <details className="mt-4 rounded-lg border border-border-medium bg-surface-secondary">
                      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">
                        {localize('com_ui_request_show_transcript', {
                          count: transcript.messages.length,
                        })}
                      </summary>
                      <div className="space-y-3 border-t border-border-medium p-4">
                        {transcript.messages.length ? (
                          transcript.messages.map((message) => (
                            <article
                              key={message.messageId}
                              className="rounded-lg bg-surface-primary p-3"
                            >
                              <div className="flex flex-wrap justify-between gap-2 text-xs text-text-secondary">
                                <span>
                                  {message.isCreatedByUser
                                    ? chat.name || localize('com_ui_request_participant')
                                    : message.sender || localize('com_ui_request_assistant')}
                                </span>
                                <time dateTime={message.createdAt}>
                                  {new Date(message.createdAt).toLocaleString()}
                                </time>
                              </div>
                              {message.text ? (
                                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text-primary">
                                  {message.text}
                                </p>
                              ) : null}
                            </article>
                          ))
                        ) : (
                          <p className="text-sm text-text-secondary">
                            {localize('com_ui_request_transcript_empty')}
                          </p>
                        )}
                        {transcript.truncated ? (
                          <p className="text-xs text-text-secondary">
                            {localize('com_ui_request_transcript_truncated')}
                          </p>
                        ) : null}
                      </div>
                    </details>
                  );
                })()
              )}
            </li>
          ))}
        </ul>
      </section>

      {request.events?.length ? (
        <section className="mt-8" aria-labelledby="request-activity-heading">
          <h2
            id="request-activity-heading"
            className="mb-3 text-lg font-semibold text-text-primary"
          >
            {localize('com_ui_request_activity')}
          </h2>
          <ol className="space-y-2 border-l border-border-medium pl-4">
            {request.events
              .slice()
              .reverse()
              .map((event, index) => (
                <li key={`${event.at}:${event.actorId}:${index}`} className="text-sm">
                  <span className="font-medium text-text-primary">
                    {localize(`com_ui_request_event_${event.action}` as never)}
                  </span>
                  {event.status && (
                    <span className="ml-2 text-text-secondary">
                      {localize(`com_ui_request_status_${event.status}` as never)}
                    </span>
                  )}
                  <p className="mt-1 text-xs text-text-secondary">
                    {new Date(event.at).toLocaleString()}
                  </p>
                </li>
              ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

export default function RequestView() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { requestId } = useParams();
  const [input, setInput] = useState(requestId ?? '');
  useEffect(() => setInput(requestId ?? ''), [requestId]);
  const detailQuery = useTrackedRequestQuery(requestId ?? '', { enabled: !!requestId });
  const listQuery = useTrackedRequestsQuery({ enabled: !requestId });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = input.trim();
    if (value) navigate(`/requests/${encodeURIComponent(value)}`);
  };

  return (
    <main className="mx-auto h-full w-full max-w-5xl overflow-y-auto px-4 pb-12 pt-20 text-text-primary md:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{localize('com_ui_requests_title')}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {localize('com_ui_requests_description')}
          </p>
        </div>
        {requestId && (
          <Link to="/requests" className="text-sm underline underline-offset-4">
            {localize('com_ui_requests_all')}
          </Link>
        )}
      </div>

      <form onSubmit={submit} className="mb-6 flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="request-id-input">
          {localize('com_ui_request_id')}
        </label>
        <input
          id="request-id-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={localize('com_ui_request_id_placeholder')}
          className="min-w-0 flex-1 rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-2 focus:ring-ring-primary"
        />
        <Button type="submit" disabled={!input.trim()}>
          {localize('com_ui_request_find')}
        </Button>
      </form>

      {requestId ? (
        detailQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : detailQuery.isError || !detailQuery.data ? (
          <p
            role="alert"
            className="rounded-lg border border-border-medium p-4 text-text-secondary"
          >
            {localize('com_ui_request_load_failed')}
          </p>
        ) : (
          <RequestDetails request={detailQuery.data} />
        )
      ) : listQuery.isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : listQuery.isError ? (
        <p role="alert" className="rounded-lg border border-border-medium p-4 text-text-secondary">
          {localize('com_ui_request_load_failed')}
        </p>
      ) : listQuery.data?.length ? (
        <div className="space-y-3">
          {listQuery.data.map((request) => (
            <RequestCard key={request.id} request={request} />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-border-medium p-4 text-text-secondary">
          {localize('com_ui_requests_empty')}
        </p>
      )}
    </main>
  );
}
