import type { WorkspaceRole, WorkspaceRole as Role } from '@notecloud/shared';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  timezone: string;
  locale: string;
  role: 'USER' | 'ADMIN';
  emailVerified: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  color: string | null;
  isPersonal: boolean;
  role: Role;
  memberCount: number;
}

export interface SiteStatus {
  siteName: string;
  version: string;
  initialized: boolean;
  registration: {
    enabled: boolean;
    requireEmailVerification: boolean;
    mailConfigured: boolean;
  };
}

export interface MemberRow {
  userId: string;
  membershipId: string;
  role: Role;
  joinedAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    status: 'ACTIVE' | 'DISABLED';
  };
}

export interface InvitationRow {
  id: string;
  email: string | null;
  role: WorkspaceRole;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  maxUses: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
  invitedBy: { id: string; name: string };
  usable: boolean;
}

export interface SessionRow {
  id: string;
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}
