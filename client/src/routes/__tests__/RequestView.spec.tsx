import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RequestView from '../RequestView';

jest.mock('~/data-provider', () => ({
  useTrackedRequestChatsQuery: () => ({
    data: [
      {
        conversationId: 'requester-thread',
        userId: 'requester-id',
        title: 'Claims event delivery',
        role: 'requester',
        truncated: false,
        messages: [
          {
            messageId: 'requester-message',
            sender: 'Karthikeyan',
            text: 'We need reliable status updates for the claims portal.',
            isCreatedByUser: true,
            createdAt: '2026-10-28T00:01:00.000Z',
          },
          {
            messageId: 'assistant-message',
            sender: 'Platform Architect Intake',
            text: 'What happens when a notification delivery is delayed?',
            isCreatedByUser: false,
            createdAt: '2026-10-28T00:02:00.000Z',
          },
        ],
      },
      {
        conversationId: 'security-thread',
        userId: 'security-id',
        title: 'Claims event delivery security review',
        role: 'approver',
        truncated: false,
        messages: [
          {
            messageId: 'security-message',
            sender: 'Security Reviewer',
            text: 'Use a minimal event payload and scoped consumer access.',
            isCreatedByUser: true,
            createdAt: '2026-10-28T00:03:00.000Z',
          },
        ],
      },
    ],
    isLoading: false,
    isError: false,
  }),
  useTrackedRequestQuery: () => ({
    data: {
      id: 'request-1',
      title: 'Claims event delivery',
      summary: 'Deliver status changes to two consumers.',
      status: 'review',
      chats: [
        {
          conversationId: 'requester-thread',
          userId: 'requester-id',
          name: 'Karthikeyan',
          email: 'karthikeyan@example.com',
          role: 'requester',
          readOnlyUrl: 'http://localhost/share/requester',
        },
        {
          conversationId: 'security-thread',
          userId: 'security-id',
          name: 'Security Reviewer',
          email: 'security@example.com',
          role: 'approver',
          readOnlyUrl: 'http://localhost/share/security',
        },
        {
          conversationId: 'devops-thread',
          userId: 'devops-id',
          name: 'DevOps Executor',
          email: 'devops@example.com',
          role: 'collaborator',
          readOnlyUrl: 'http://localhost/share/devops',
        },
      ],
      approvals: [],
      events: [],
      updatedAt: '2026-10-28T00:00:00.000Z',
    },
    isLoading: false,
    isError: false,
  }),
  useTrackedRequestsQuery: () => ({ data: [], isLoading: false, isError: false }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'security-id' } }),
  useLocalize: () => (key: string, values?: { name?: string }) => {
    if (key === 'com_ui_request_thread_started_by') {
      return `Request started by ${values?.name}`;
    }
    if (key === 'com_ui_request_thread_to') {
      return `Thread to ${values?.name}`;
    }
    return key;
  },
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => <span>loading</span>,
}));

describe('RequestView conversation labels', () => {
  it('names each related thread by the participant it was started for', () => {
    render(
      <MemoryRouter initialEntries={['/requests/request-1']}>
        <Routes>
          <Route path="/requests/:requestId" element={<RequestView />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getAllByText('Request started by Karthikeyan')).toHaveLength(3);
    expect(screen.getAllByText('Thread to Security Reviewer')).toHaveLength(2);
    expect(screen.getByText('Thread to DevOps Executor')).toBeInTheDocument();
  });

  it('shows the request conversation history across threads without expanding each transcript', () => {
    render(
      <MemoryRouter initialEntries={['/requests/request-1']}>
        <Routes>
          <Route path="/requests/:requestId" element={<RequestView />} />
        </Routes>
      </MemoryRouter>,
    );

    const history = screen.getByRole('region', { name: 'com_ui_request_conversation_history' });
    expect(
      within(history).getByText('We need reliable status updates for the claims portal.'),
    ).toBeVisible();
    expect(
      within(history).getByText('What happens when a notification delivery is delayed?'),
    ).toBeVisible();
    expect(
      within(history).getByText('Use a minimal event payload and scoped consumer access.'),
    ).toBeVisible();
    expect(within(history).getAllByRole('link', { name: 'com_ui_request_open_source_thread' }))
      .toHaveLength(3);
  });
});
