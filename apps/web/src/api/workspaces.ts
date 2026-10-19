import { apiPost } from './client';

export interface CreatedWorkspace {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  color: string | null;
  isPersonal: boolean;
  role: string;
  memberCount: number;
}

export function createWorkspace(payload: { name: string; icon?: string | null; color?: string | null }) {
  return apiPost<{ workspace: CreatedWorkspace }>('/workspaces', payload);
}
