import styles from './style.module.scss';
import { useState, useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { getConversationMessages, updateConversationTime } from '@/globalApi/chatApi';
import { updateRemark } from '@/globalApi/friendApi';
import type { RootState } from '@/store/rootStore';
import { useNavigate } from 'react-router-dom';
import { addConversation, addUserConversation, addGlobalFriend, initActiveConversation, initGlobalMessages } from '@/store/chatStore';
import type { ApiResponse } from '@/globalType/apiResponse';
import type { Message } from '@/globalType/message';
import { useCall } from '@/hooks/useCall';
import { type CallUser, type CallType } from '@/globalType/call';

interface FriendModalProps {
    style?: React.CSSProperties; //css原型
    avatar: string; // 定义类型可以用分号
    username: string;
    wxid: string;
    region: string;
    remark: string | null;
    gender: string;
}

function FriendModal({
    style,
    avatar,
    username,
    wxid,
    region,
    remark,
    gender,
}: FriendModalProps) {
    const navigate = useNavigate();
    const dispatch = useDispatch();
    const userId = useSelector((state: RootState) => state.user.id);
    const globalConversations = useSelector((state: RootState) => state.chat.globalConversations);
    const { initiateCall } = useCall();

    // 备注本地态:切换好友(wxid 变)时同步成该好友的备注;保存后用本地值即时展示
    const [currentRemark, setCurrentRemark] = useState<string | null>(remark);
    const [editingRemark, setEditingRemark] = useState(false);
    const [remarkDraft, setRemarkDraft] = useState('');
    // Esc 取消:置位后让随之而来的失焦保存跳过,避免按 Esc 反而把草稿存了
    const skipRemarkSaveRef = useRef(false);
    useEffect(() => {
        setCurrentRemark(remark);
        setEditingRemark(false);
    }, [wxid, remark]);

    // 进入备注编辑
    const beginEditRemark = () => {
        setRemarkDraft(currentRemark ?? '');
        setEditingRemark(true);
    };
    // 保存备注:空串/全空白视为清空。先落本地态再请求,失败也不影响展示一致性。
    const saveRemark = async () => {
        setEditingRemark(false);
        if (skipRemarkSaveRef.current) {
            skipRemarkSaveRef.current = false;
            return;
        }
        const next = remarkDraft.trim() ? remarkDraft.trim() : null;
        if (next === currentRemark) return;
        setCurrentRemark(next);
        const friendId = parseInt(wxid);
        await updateRemark({ userId, friendId: friendId, remark: next });
        dispatch(addGlobalFriend({ friendId: friendId, remark: next }));
    };

    // 点击发送消息
    const handleClickSendMessage = async () => {
        const conversationId = `single_${Math.min(userId, parseInt(wxid))}_${Math.max(userId, parseInt(wxid))}`;
        // 这里更新会话时间，保证会话列表中会话时间最新
        updateConversationTime({conversationId, userId}).then(() => {
            // 用户友好式更新
            //注：有些字段数据库实际是不需要的（为null），前端正常加，渲染时的逻辑用不到这些字段
            if(!globalConversations[conversationId as string]) {
                dispatch(addConversation({
                    id: conversationId,
                    convType: 'single',
                    title: username,
                    avatar: avatar,
                    nextSeq: 0,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }))
                dispatch(addUserConversation({
                    id: 0,
                    userId: userId,
                    conversationId: conversationId,
                    lastReadMessageId: '',
                    lastSyncedSeq: 0,
                    lastReadSeq: 0,
                    mentionSeq: 0,
                    unreadCount: 0,
                    isMuted: false,
                    isPinned: false,
                    isArchived: false,
                    joinedAt: new Date().toISOString(),
                    lastActivity: new Date().toISOString(),
                }))
            }
        });
        // 获取会话消息
        await getConversationMessages(conversationId).then((res: ApiResponse<Message[]>) => {
            dispatch(initGlobalMessages(res.data ?? []));
        });
        // 设置当前会话:选中态进入 URL,chatView 据此同步并展示
        dispatch(initActiveConversation(conversationId));
        navigate(`/chat/${conversationId}`);
    }

    // 发起通话(语音/视频共用同一信令,仅类型不同)
    const startCallWith = (callType: CallType) => {
        const targetUser: CallUser = {
          id: parseInt(wxid),
          username: username,
          nickname: currentRemark || username,
          avatar: avatar,
        };
        initiateCall(targetUser, callType);
    };
    const handleClickVoiceChat = () => startCallWith('voice');
    const handleClickVideoChat = () => startCallWith('video');

    return (
      <div className={styles.detail} style={style}>
        {/* 头部:头像 + 昵称(含性别) + 微信号/地区 */}
        <div className={styles.header}>
            <img className={styles.avatar} src={avatar} alt="" />
            <div className={styles.headMain}>
                <div className={styles.nameRow}>
                    <span className={styles.name}>{currentRemark || username}</span>
                    <i className={`iconfont icon-user ${styles.gender} ${gender === 'female' ? styles.genderFemale : ''}`} />
                </div>
                <div className={styles.sub}>昵称：{username}</div>
                <div className={styles.sub}>微信号：{wxid}</div>
                <div className={styles.sub}>地区：{region}</div>
            </div>
        </div>

        <div className={styles.divider} />

        {/* 备注:点击进入编辑,回车/失焦保存,Esc 取消 */}
        <div className={styles.row}>
            <span className={styles.rowLabel}>备注</span>
            {editingRemark ? (
                <input
                    className={styles.remarkInput}
                    value={remarkDraft}
                    autoFocus
                    maxLength={20}
                    placeholder="设置备注"
                    onChange={(e) => setRemarkDraft(e.target.value)}
                    onBlur={saveRemark}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        else if (e.key === 'Escape') {
                            skipRemarkSaveRef.current = true;
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                />
            ) : (
                <span className={styles.rowValue} onClick={beginEditRemark}>
                    {currentRemark || <span className={styles.placeholder}>点击添加备注</span>}
                </span>
            )}
        </div>

        <div className={styles.divider} />

        {/* 操作:发消息 / 语音聊天 / 视频聊天 */}
        <div className={styles.actions}>
            <button type="button" className={styles.action} onClick={handleClickSendMessage}>
                <i className="iconfont icon-message" />
                <span>发消息</span>
            </button>
            <button type="button" className={styles.action} onClick={handleClickVoiceChat}>
                <i className="iconfont icon-phone" />
                <span>语音聊天</span>
            </button>
            <button type="button" className={styles.action} onClick={handleClickVideoChat}>
                <i className="iconfont icon-video" />
                <span>视频聊天</span>
            </button>
        </div>
      </div>

  );
}

export default FriendModal;
