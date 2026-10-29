import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RequestView from '../RequestView';

jest.mock('~/data-provider', () => ({
  useTrackedRequestChatsQuery: () => ({ data: [], isLoading: false, isError: false }),
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

    expect(screen.getByText('Request started by Karthikeyan')).toBeInTheDocument();
    expect(screen.getByText('Thread to Security Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Thread to DevOps Executor')).toBeInTheDocument();
  });
});
