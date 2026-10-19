import { apiDelete, apiGet, apiUpload } from './client';

export interface AttachmentDto {
  id: string;
  /** 能力链接：/api/v1/attachments/<id>/<token> */
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploader?: { id: string; name: string };
}

export function uploadAttachment(workspaceId: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  return apiUpload<{ attachment: AttachmentDto }>(`/workspaces/${workspaceId}/attachments`, form);
}

export function listAttachments(workspaceId: string) {
  return apiGet<{
    items: AttachmentDto[];
    storage: { driver: string; maxUploadMB: number };
  }>(`/workspaces/${workspaceId}/attachments`);
}

export function deleteAttachment(workspaceId: string, attachmentId: string) {
  return apiDelete<{ deleted: boolean }>(`/workspaces/${workspaceId}/attachments/${attachmentId}`);
}

/** 人类可读的体积 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
