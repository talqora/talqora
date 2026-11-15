import { get, put } from '@/utils/http'; 
import type { FriendInfo, FriendList } from '@/globalType/friend';
import type { FriendReq } from '@/store/friendStore';

interface FriendListResponse {
    friendId: FriendList;
    friendInfo: Record<number, FriendInfo>;
}

interface SearchUserResponse {
    exist: boolean;
    isFriend: boolean;
    friendInfo: FriendInfo & { id: number };
}

// 获取好友列表
export const getFriendList = (id: number) => {
    return get<FriendListResponse>(`/user/getFriendList/${id}`);
}
// 分页获取好友:键集分页(friend_id 递增),limit 上限 200。
// 后端仅在传 limit 时返回 hasMore/nextAfter;不传仍是全量(兼容旧调用)。
export interface FriendPage {
    friendId: FriendList;
    friendInfo: Record<number, FriendInfo>;
    hasMore?: boolean;
    nextAfter?: number;
}
export const getFriendListPage = (id: number, after: number, limit = 50) => {
    return get<FriendPage>(`/user/getFriendList/${id}`, { params: { after, limit } });
}
// 查询用户信息(按 用户名 / 手机号 / 用户ID;keyword 原样传字符串,后端做多字段匹配)
export const searchUser = ({keyword, userId}: {keyword: string | number, userId: number}) => {
    return get<SearchUserResponse>(`/user/searchUser`, { params: { keyword, userId } });
}
// 发起好友请求
export const addFriend = ({userId, friendId}: {userId: number, friendId: number}) => {
    return put<void, { userId: number; friendId: number }>(`/user/addFriend`, { userId, friendId });
}
//获取好友请求
export const getFriendReqs = (userId: number) => {
    return get<Record<number, FriendReq>>(`/user/getFriendReqs`, { params: { userId } });
}
// 分页获取好友请求:id 倒序键集分页,limit 上限 200。不传 limit 仍是全量(兼容旧调用)。
export interface FriendReqPage extends Record<string | number, unknown> {
    hasMore?: boolean;
    nextBefore?: number;
}
export const getFriendReqsPage = (userId: number, before: number, limit = 30) => {
    return get<FriendReqPage>(`/user/getFriendReqs`, { params: { userId, before, limit } });
}
//回复好友请求
export const replyFriendReq = ({userId, friendId, status}: {userId: number, friendId: number, status: string}) => {
    return put<void, { userId: number; friendId: number; status: string }>(`/user/replyFriendReq`, { userId, friendId, status });
}
// 更新好友备注(remark 为空串/全空白时清空备注)
export const updateRemark = ({userId, friendId, remark}: {userId: number, friendId: number, remark: string | null}) => {
    return put<void, { userId: number; friendId: number; remark: string | null }>(`/user/updateRemark`, { userId, friendId, remark });
}