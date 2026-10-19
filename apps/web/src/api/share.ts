import { apiDelete, apiGet, apiPost } from './client';

export interface ShareLinkDto {
  id: string;
  path: string;
  expiresAt: string | null;
  revokedAt: string | null;
  viewCount: number;
  createdAt: string;
  createdBy: { id: string; name: string };
  usable: boolean;
}

export interface SharedNoteDto {
  title: string;
  content: string;
  updatedAt: string;
  author: string;
  workspaceName: string;
  sharedBy: string;
  expiresAt: string | null;
  viewCount: number;
}

export function createShareLink(workspaceId: string, noteId: string, expiresInDays?: number | null) {
  return apiPost<{ link: { id: string; path: string; expiresAt: string | null } }>(
    `/workspaces/${workspaceId}/notes/${noteId}/share`,
    { expiresInDays: expiresInDays ?? null },
  );
}

export function listShareLinks(workspaceId: string, noteId: string) {
  return apiGet<{ items: ShareLinkDto[] }>(`/workspaces/${workspaceId}/notes/${noteId}/share`);
}

export function revokeShareLink(workspaceId: string, linkId: string) {
  return apiDelete<{ revoked: boolean }>(`/workspaces/${workspaceId}/share-links/${linkId}`);
}

/** 公开读取（不带 token） */
export function getSharedNote(token: string) {
  return apiGet<{ note: SharedNoteDto }>(`/share/${token}`);
}
