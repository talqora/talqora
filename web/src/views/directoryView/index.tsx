import directoryViewStyle from './style.module.scss';
import { useEffect, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import FriendModal from '@/globalComponents/friendModal';
import type { RootState } from '@/store/rootStore';
import DisplayItem from '@/globalComponents/displayItem';
import SearchHeader from '@/globalComponents/searchHeader';
import { searchUser, replyFriendReq } from '@/globalApi/friendApi';
import AddFriendModal from '@/globalComponents/addFriendModal';
import { setFriendReqStatus } from '@/store/friendStore';
import {type Message } from '@/globalType/message';
import SocketService from '@/utils/socket';
import { addGlobalFriend, addGlobalFriendInfo } from '@/store/chatStore';
import { buildServerUrl } from '@/utils/runtime';
import { defaultAvatar, searchUserIcon, newFriendIcon } from '@/assets/images';
import { useLang } from '@/i18n';
function DirectoryView() {
    const { t } = useLang();
    const [activeFriend, setActiveFriend] = useState<{ friendId: number, remark: string | null } | null>(null);
    const globalFriendList = useSelector((state: RootState) => state.chat.globalFriendList);
    const globalFriendInfoList = useSelector((state: RootState) => state.chat.globalFriendInfoList);
    const globalFriendReqList = useSelector((state: RootState) => state.friendReq);
    const dispatch = useDispatch();
    const userId = useSelector((state: RootState) => state.user.id);
    const [isCheckingFriendReq, setIsCheckingFriendReq] = useState(false);
    const socket = SocketService.getInstance();
    // 点击好友
    const handleFriendClick = (friend: { friendId: number, remark: string | null }) => {
        setIsCheckingFriendReq(false);
        setActiveFriend(friend);
    }
    // 搜索
    const [searchValue, setSearchValue] = useState('');
    //绑定搜索值
    const handleSearchChange = (value: string) => {
        setSearchValue(value);
    }
    // 添加好友
    const [isAddingFriend, setIsAddingFriend] = useState(false);
    const handleClickAddFriend = () => {
        setIsAddingFriend(!isAddingFriend);
    }
    // 点击展示卡片搜索
    const [showAddFriendModal, setShowAddFriendModal] = useState(false);
    const addFriendModalRef = useRef<HTMLDivElement>(null); // 绑定组件 
    const [friendInfo, setFriendInfo] = useState<{id: number, username: string, avatar: string, gender: string}>();
    const [hasResult, setHasResult] = useState(true);
    const handleClickSearchFriend = async () => {
        if(isCheckingFriendReq) setIsCheckingFriendReq(false);
        if(searchValue.trim().length < 1) return;
        const res = await searchUser({keyword: searchValue.trim(), userId});
        const searchResult = res.data;
        if (!searchResult) return;
        if(searchResult.exist) {
            if(searchResult.isFriend) {
                // 用户存在且是好友
                setActiveFriend({ friendId: searchResult.friendInfo.id, remark: globalFriendList[searchResult.friendInfo.id] || null });
            } else {
                // 用户存在且不是好友
                setShowAddFriendModal(true);
                if (searchResult.friendInfo) {
                    setFriendInfo({
                        id: searchResult.friendInfo.id,
                        username: searchResult.friendInfo.username,
                        avatar: searchResult.friendInfo.avatar ?? '',
                        gender: searchResult.friendInfo.gender ?? '',
                    });
                }
            }
        } else {
            // 用户不存在
            setHasResult(false);
        }
    }
    // 点击新朋友卡片
    const handleClickNewFriend = () => {
        setActiveFriend(null);
        setIsCheckingFriendReq(true);
    }
    // 回复好友请求
    const handleReplyFriendReq = async (friendId: number, status: string) => {
        replyFriendReq({userId, friendId, status}).then( async () => {
            dispatch(setFriendReqStatus({friendId, status}));
            if(status === "accepted") {
                const otherInfo = await searchUser({keyword: friendId, userId});
                const otherUser = otherInfo.data?.friendInfo;
                if (!otherUser) {
                    return;
                }
                const conversationId = `single_${Math.min(userId, friendId)}_${Math.max(userId, friendId)}`;                
                // 创建会话记录
                
                // 创建初始消息 
                const msg:Message = {
                    id: 0,
                    clientMsgId: '',
                    seq: 0,
                    conversationId: conversationId,
                    senderId: friendId,
                    content: t('directory.hello') + otherUser.username,
                    type: 'text',
                    status: 'sent',
                    mentions: [],
                    isEdited: false,
                    isDeleted: false,
                    extra: {},
                    editHistory: [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    timestamp: new Date().toISOString(),
                };
                socket.emit('sendMessage', msg);
                // 更新好友列表
                dispatch(addGlobalFriend({friendId, remark: null}));
                dispatch(addGlobalFriendInfo({friendId, friendInfo: {
                    username: otherUser.username,
                    avatar: otherUser.avatar,
                    gender: otherUser.gender,
                }}));
            }
        })
    }
    // 监听全局点击事件
    useEffect(() => {
        if (!showAddFriendModal) return;
        function handleClick(event: MouseEvent) {
          if (
            addFriendModalRef.current &&
            !addFriendModalRef.current.contains(event.target as Node)
          ) {
            setShowAddFriendModal(false);
          }
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [showAddFriendModal]);
    // 监听搜索值（为零时修改hasResult）
    useEffect(() => {
        if(searchValue.length < 1) {
            setHasResult(true);
        }
    }, [searchValue]);
    // TSX
    return (
        <div className={`${directoryViewStyle.container} ${(activeFriend || isCheckingFriendReq) ? directoryViewStyle.has_active : ''}`}>
            {/* 左侧 */}
            <div className={directoryViewStyle.left}>
                {/* 头部:搜索 + 切换添加好友(action 槽) */}
                <SearchHeader
                    onSearchChange={handleSearchChange}
                    placeholder={isAddingFriend ? t('directory.addSearchPlaceholder') : t('directory.searchPlaceholder')}
                    action={
                        <div className={directoryViewStyle.left_header_add_user_container} onClick={handleClickAddFriend}>
                            {isAddingFriend
                                ? <p style={{ fontSize: '11px' }}>{t('directory.cancel')}</p>
                                : <i className={`iconfont icon-adduser ${directoryViewStyle.left_header_add_user}`}></i>}
                        </div>
                    }
                />
                {/* 列表展示 */}
                <div className={directoryViewStyle.left_body}>
                    {
                        isAddingFriend 
                        ? (
                            <div style={{width: '100%', display: 'flex',flexDirection: 'column'}}>
                                {/* 搜索结果不存在时 */}
                                {
                                    !hasResult && (
                                        <div className={directoryViewStyle.noResult}>
                                            <p>{t('directory.notFound')}</p>
                                        </div>
                                    )
                                }
                                <DisplayItem
                                    id={''}
                                    avatar={searchUserIcon}
                                    title={t('directory.searchPrefix')}
                                    content={searchValue}
                                    handleClick={handleClickSearchFriend}
                                />
                                {/* 添加好友弹窗 */}
                                {showAddFriendModal && (
                                    <AddFriendModal
                                        ref={addFriendModalRef}
                                        avatar={friendInfo?.avatar ? buildServerUrl(friendInfo.avatar) : defaultAvatar}
                                        username={friendInfo?.username as string}
                                        wxid={friendInfo?.id.toString() as string}
                                        region={t('directory.region')}
                                        gender={friendInfo?.gender as string}
                                    />
                                )}
                            </div>
                        ) 
                        : (
                            <>
                                <DisplayItem
                                    id={''}
                                    avatar={newFriendIcon}
                                    title={t('directory.newFriend')}
                                    content={''}
                                    handleClick={handleClickNewFriend}
                                />
                                {Object.keys(globalFriendList)
                                    .filter(item => {
                                        const friendInfo = globalFriendInfoList[Number(item)];
                                        return friendInfo?.username.includes(searchValue) && globalFriendReqList[Number(item)].status === 'accepted';
                                    })
                                    .map((item: string) => {
                                        const friendId = Number(item);
                                        const friendInfo = globalFriendInfoList[friendId];
                                        
                                        return (
                                            <DisplayItem
                                                key={item}
                                                id={item}
                                                title={globalFriendList[friendId] || friendInfo?.username}
                                                content={''}
                                                isActive={activeFriend?.friendId === friendId}
                                                handleClick={() => handleFriendClick({ 
                                                    friendId: friendId, 
                                                    remark: globalFriendList[friendId] 
                                                })}
                                                avatar={friendInfo?.avatar 
                                                    ? buildServerUrl(friendInfo.avatar) 
                                                    : defaultAvatar}
                                            />
                                        );
                                    })}
                            </>
                        )
                    }
                </div>
            </div>
            {/* 右侧 */}
            <div className={directoryViewStyle.right}>
                {/* 移动端返回按钮:回到通讯录列表(桌面端 CSS 隐藏) */}
                <i
                    className={directoryViewStyle.back_btn}
                    onClick={() => { setActiveFriend(null); setIsCheckingFriendReq(false); }}
                />
                {/* 好友信息 */}
                {activeFriend && (
                    <FriendModal
                        avatar={globalFriendInfoList[activeFriend?.friendId as number]?.avatar
                            ? buildServerUrl(globalFriendInfoList[activeFriend?.friendId as number].avatar ?? '')
                            : defaultAvatar}
                        username={globalFriendInfoList[activeFriend?.friendId as number]?.username}
                        wxid={activeFriend?.friendId.toString() as string}
                        region={t('directory.region')}
                        remark={activeFriend?.remark as string | null}
                        gender={globalFriendInfoList[activeFriend?.friendId as number].gender as string}
                    />
                )}
                {/* 检查新朋友 */}
                {isCheckingFriendReq && (
                    <div className={directoryViewStyle.friendReqBox}>
                        <div className={directoryViewStyle.friendReqHeader}>
                            <p className={directoryViewStyle.title}>{t('directory.title.newFriendRequests')}</p>
                        </div>
                        <div className={directoryViewStyle.friendReqList}>
                            {
                                Object.keys(globalFriendReqList).map((item: string) => {
                                    const friendInfo = globalFriendInfoList[Number(item)];
                                    const req = globalFriendReqList[Number(item)];
                                    // 请求方多半还不是好友,friendInfo 取不到,回退到请求自带的 username/avatar
                                    const reqName = friendInfo?.username ?? req?.username ?? '';
                                    const reqAvatar = friendInfo?.avatar ?? req?.avatar;
                                    return (
                                        <div className={directoryViewStyle.friendReqItem} key={item}>
                                            <DisplayItem
                                            id={item} title={reqName} content={''}
                                            avatar={reqAvatar
                                            ? buildServerUrl(reqAvatar)
                                            : defaultAvatar}
                                            style={{width: '55px', height: '55px', backgroundColor: 'transparent'}}/>
                                            {/* 请求状态 */}
                                            <div className={directoryViewStyle.rightBox}>
                                                {
                                                    globalFriendReqList[Number(item)].status === 'pending'
                                                    ? (
                                                    <div className={directoryViewStyle.rightBox_btn}>
                                                        <div className={directoryViewStyle.rightBox_btn_reject}
                                                        onClick={() => handleReplyFriendReq(Number(item), 'blocked')}>
                                                            {t('directory.req.reject')}
                                                        </div>

                                                        <div className={directoryViewStyle.rightBox_btn_accept}
                                                        onClick={() => handleReplyFriendReq(Number(item), 'accepted')}>
                                                            {t('directory.req.accept')}
                                                        </div>
                                                    </div>
                                                    )
                                                    : (
                                                        <div className={directoryViewStyle.rightBox_status}>
                                                            {
                                                                globalFriendReqList[Number(item)].status === 'sent'
                                                                ? <p>{t('directory.req.pending')}</p>
                                                                : <p>{globalFriendReqList[Number(item)].status === 'accepted' ? t('directory.req.accepted') : t('directory.req.rejected')}</p>
                                                            }
                                                        </div>
                                                    )
                                                }
                                            </div>
                                        </div>
                                    );
                                })
                            }                            
                        </div>

                    </div>
                )}
            </div>
        </div>
    )
}

export default DirectoryView;