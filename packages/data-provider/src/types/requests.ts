export type TRequestChat = {
  conversationId: string;
  userId: string;
  email?: string;
  name?: string;
  role: 'requester' | 'approver' | 'collaborator';
  agentId?: string;
  readOnlyUrl?: string;
  linkedAt: string;
};

export type TTrackedRequest = {
  id: string;
  tenantId: string;
  deploymentId: string;
  createdBy: string;
  title: string;
  summary?: string;
  status: 'discovering' | 'review' | 'approved' | 'rejected' | 'completed' | 'cancelled';
  chats: TRequestChat[];
  approvals?: Array<{
    approverId: string;
    decision: 'approved' | 'rejected';
    conditions?: string[];
    validUntil?: string;
    decidedAt: string;
  }>;
  events?: Array<{
    actorId: string;
    action: string;
    status?: TTrackedRequest['status'];
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
  revision: number;
};
