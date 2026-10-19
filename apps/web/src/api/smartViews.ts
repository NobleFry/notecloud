import type { SmartViewFilter } from '@notecloud/shared';

import { apiDelete, apiGet, apiPatch, apiPost } from './client';

export interface SmartViewDto {
  id: string;
  name: string;
  icon: string | null;
  filter: SmartViewFilter;
  isShared: boolean;
  ownerId: string | null;
  position: number;
  createdAt: string;
}

export function listSmartViews(workspaceId: string) {
  return apiGet<{ items: SmartViewDto[] }>(`/workspaces/${workspaceId}/smart-views`);
}

export function createSmartView(
  workspaceId: string,
  payload: { name: string; icon?: string | null; filter: SmartViewFilter; isShared: boolean },
) {
  return apiPost<{ view: SmartViewDto }>(`/workspaces/${workspaceId}/smart-views`, payload);
}

export function updateSmartView(
  workspaceId: string,
  viewId: string,
  payload: { name?: string; icon?: string | null; filter?: SmartViewFilter; isShared?: boolean },
) {
  return apiPatch<{ view: SmartViewDto }>(`/workspaces/${workspaceId}/smart-views/${viewId}`, payload);
}

export function deleteSmartView(workspaceId: string, viewId: string) {
  return apiDelete<{ deleted: boolean }>(`/workspaces/${workspaceId}/smart-views/${viewId}`);
}
