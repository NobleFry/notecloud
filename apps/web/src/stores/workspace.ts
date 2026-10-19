import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client';
import type { InvitationRow, MemberRow } from '@/api/types';
import type { WorkspaceRole } from '@notecloud/shared';

interface WorkspaceDetail {
  workspace: {
    id: string;
    name: string;
    slug: string;
    icon: string | null;
    color: string | null;
    isPersonal: boolean;
    createdAt: string;
  };
  role: WorkspaceRole;
  memberCount: number;
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const currentId = ref<string | null>(null);
  const detail = ref<WorkspaceDetail | null>(null);
  const members = ref<MemberRow[]>([]);
  const invitations = ref<InvitationRow[]>([]);
  const loading = ref(false);

  const canAdmin = computed(() => detail.value?.role === 'OWNER' || detail.value?.role === 'ADMIN');
  const canInvite = computed(() => canAdmin.value); // 已确认：MEMBER 不能邀请
  const isOwner = computed(() => detail.value?.role === 'OWNER');

  async function load(id: string): Promise<void> {
    loading.value = true;
    currentId.value = id;
    try {
      detail.value = await apiGet<WorkspaceDetail>(`/workspaces/${id}`);
    } finally {
      loading.value = false;
    }
  }

  async function loadMembers(q?: string): Promise<void> {
    if (!currentId.value) return;
    const page = await apiGet<{ items: MemberRow[] }>(`/workspaces/${currentId.value}/members`, {
      params: { limit: 100, ...(q ? { q } : {}) },
    });
    members.value = page.items;
  }

  async function loadInvitations(): Promise<void> {
    if (!currentId.value) return;
    const data = await apiGet<{ items: InvitationRow[] }>(`/workspaces/${currentId.value}/invitations`);
    invitations.value = data.items;
  }

  async function updateWorkspace(payload: { name?: string; color?: string | null }): Promise<void> {
    if (!currentId.value) return;
    await apiPatch(`/workspaces/${currentId.value}`, payload);
    await load(currentId.value);
  }

  async function updateMemberRole(userId: string, role: 'ADMIN' | 'MEMBER' | 'GUEST'): Promise<void> {
    if (!currentId.value) return;
    await apiPatch(`/workspaces/${currentId.value}/members/${userId}`, { role });
    await loadMembers();
  }

  async function removeMember(userId: string): Promise<void> {
    if (!currentId.value) return;
    await apiDelete(`/workspaces/${currentId.value}/members/${userId}`);
    await loadMembers();
  }

  async function createInvitation(payload: {
    email?: string;
    role: 'ADMIN' | 'MEMBER' | 'GUEST';
    maxUses: number;
    expiresInDays: number;
  }): Promise<{ url: string }> {
    if (!currentId.value) throw new Error('未选择工作区');
    const data = await apiPost<{ invitation: { url: string } }>(
      `/workspaces/${currentId.value}/invitations`,
      payload,
    );
    await loadInvitations();
    return data.invitation;
  }

  async function revokeInvitation(invitationId: string): Promise<void> {
    if (!currentId.value) return;
    await apiDelete(`/workspaces/${currentId.value}/invitations/${invitationId}`);
    await loadInvitations();
  }

  async function transferOwnership(userId: string): Promise<void> {
    if (!currentId.value) return;
    await apiPost(`/workspaces/${currentId.value}/transfer`, { userId, selfRole: 'ADMIN' });
    await load(currentId.value);
  }

  function reset(): void {
    currentId.value = null;
    detail.value = null;
    members.value = [];
    invitations.value = [];
  }

  return {
    currentId,
    detail,
    members,
    invitations,
    loading,
    canAdmin,
    canInvite,
    isOwner,
    load,
    loadMembers,
    loadInvitations,
    updateWorkspace,
    updateMemberRole,
    removeMember,
    createInvitation,
    revokeInvitation,
    transferOwnership,
    reset,
  };
});
