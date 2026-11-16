import { get, post, put } from '@/utils/http';

export interface GroupMember {
  userId: number;
  username: string;
  nickname?: string | null;
  avatar?: string | null;
  role: string;
}

export interface GroupInfo {
  id: number;
  name: string;
  avatar?: string | null;
  ownerId: number;
  memberCount: number;
  members: GroupMember[];
}

export interface CreateGroupResult {
  groupId: number;
  conversationId: string;
}

// 建群:name 可空(后端默认「群聊(N)」)
export const createGroup = (userId: number, memberIds: number[], name = '') => {
  return post<CreateGroupResult, { userId: string; memberIds: number[]; name: string }>('/group/create', {
    userId: String(userId),
    memberIds,
    name,
  });
};

export const getGroupInfo = (groupId: number) => {
  return get<GroupInfo>('/group/info', { params: { groupId } });
};

export const renameGroup = (payload: { userId: number; groupId: number; name: string }) => {
  return put<void, { userId: string; groupId: number; name: string }>('/group/rename', {
    userId: String(payload.userId),
    groupId: payload.groupId,
    name: payload.name,
  });
};

export const setGroupNickname = (payload: { userId: number; groupId: number; nickname: string }) => {
  return put<void, { userId: string; groupId: number; nickname: string }>('/group/nickname', {
    userId: String(payload.userId),
    groupId: payload.groupId,
    nickname: payload.nickname,
  });
};

export const addGroupMembers = (payload: { userId: number; groupId: number; memberIds: number[] }) => {
  return post<void, { userId: string; groupId: number; memberIds: number[] }>('/group/addMembers', {
    userId: String(payload.userId),
    groupId: payload.groupId,
    memberIds: payload.memberIds,
  });
};
