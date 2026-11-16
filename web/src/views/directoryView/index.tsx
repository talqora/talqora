import directoryViewStyle from './style.module.scss';
import { useEffect, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import FriendModal from '@/globalComponents/friendModal';
import type { RootState } from '@/store/rootStore';
import DisplayItem from '@/globalComponents/displayItem';
import SearchHeader from '@/globalComponents/searchHeader';
import { searchUser, replyFriendReq, getFriendListPage, getFriendReqsPage } from '@/globalApi/friendApi';
import VirtualList from '@/globalComponents/virtualList';
import CreateGroupModal from '@/globalComponents/createGroupModal';
import AddFriendModal from '@/globalComponents/addFriendModal';
import { setFriendReqStatus } from '@/store/friendStore';
import { wsClient } from '@/ws/wsClient';
import { addGlobalFriend, addGlobalFriendInfo } from '@/store/chatStore';
import { buildServerUrl } from '@/utils/runtime';
import { defaultAvatar, searchUserIcon } from '@/assets/images';
import { useLang } from '@/i18n';
function DirectoryView() {
    const { t } = useLang();
    const [activeFriend, setActiveFriend] = useState<{ friendId: number, remark: string | null } | null>(null);
    // 新朋友里选中的请求:已同意 → 走好友面板;未同意 → 走「陌生人」面板
    const [activeReq, setActiveReq] = useState<{ key: number; id?: number; status: string; username?: string; avatar?: string } | null>(null);
    const globalFriendList = useSelector((state: RootState) => state.chat.globalFriendList);
    const globalFriendInfoList = useSelector((state: RootState) => state.chat.globalFriendInfoList);
    const globalFriendReqList = useSelector((state: RootState) => state.friendReq);
    const dispatch = useDispatch();
    const userId = useSelector((state: RootState) => state.user.id);
    const [isCheckingFriendReq, setIsCheckingFriendReq] = useState(false);
    // 点击好友
    const handleFriendClick = (friend: { friendId: number, remark: string | null }) => {
        setIsCheckingFriendReq(false);
        setActiveReq(null);
        setActiveFriend(friend);
    }
    // 点击「新朋友」里的某条请求:已是好友就复用好友面板,否则展示陌生人资料 + 添加到通讯录
    const handleReqClick = (r: { key: number; status: string; username?: string; avatar?: string }) => {
        // 无论哪种状态都记 activeReq:高亮落在「新朋友」这一行,不要串到下面联系人里的同名项
        setActiveReq(r);
        setIsCheckingFriendReq(false);
        setActiveFriend(r.status === 'accepted' ? { friendId: r.key, remark: null } : null);
    };
    // 搜索
    const [searchValue, setSearchValue] = useState('');
    //绑定搜索值
    const handleSearchChange = (value: string) => {
        setSearchValue(value);
    }
    // 添加好友
    const [isAddingFriend, setIsAddingFriend] = useState(false);
    // 发起群聊弹层(微信:通讯录「+」→ 发起群聊)
    const [groupModalOpen, setGroupModalOpen] = useState(false);
    // 左上「+」下拉菜单(微信:发起群聊 / 添加朋友)
    const [addMenuOpen, setAddMenuOpen] = useState(false);
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
    // 回复好友请求
    const handleReplyFriendReq = async (friendId: number, status: string) => {
        replyFriendReq({userId, friendId, status}).then( async () => {
            dispatch(setFriendReqStatus({friendId, status}));
            // 本地分页列表同步状态,避免为了一行状态把整页重新拉一遍
            setReqs((prev) => prev.map((r) => (r.key === friendId ? { ...r, status } : r)));
            if(status === "accepted") {
                const otherInfo = await searchUser({keyword: friendId, userId});
                const otherUser = otherInfo.data?.friendInfo;
                if (!otherUser) {
                    return;
                }
                const conversationId = `single_${Math.min(userId, friendId)}_${Math.max(userId, friendId)}`;
                // 通过 gateway 可靠上行发寒暄消息(clientMsgId 必须非空,服务端据此幂等去重)。
                wsClient
                    .sendMessage({
                        clientMsgId: crypto.randomUUID(),
                        conversationId,
                        content: t('directory.hello') + otherUser.username,
                        type: 'text',
                        mentions: [],
                    })
                    .catch((err: Error) => console.error('寒暄消息发送未确认:', err.message));
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
    // ─── 联系人分页 + 懒加载 ───
    // 联系人数无上限:不一次性拉全量,按 friend_id 键集分页,滚到底部再取下一页。
    const PAGE = 50;
    const [reqOpen, setReqOpen] = useState(false);       // 新朋友分组展开态
    const [contactsOpen, setContactsOpen] = useState(true); // 联系人分组展开态
    const [contacts, setContacts] = useState<Array<{ id: number; username: string; avatar?: string; remark: string | null }>>([]);
    const [hasMore, setHasMore] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const cursorRef = useRef(0);
    const loadingRef = useRef(false);

    const loadPage = () => {
        if (loadingRef.current || !hasMore) return;
        loadingRef.current = true;
        setLoadingMore(true);
        getFriendListPage(userId, cursorRef.current, PAGE)
            .then((res) => {
                const d = res.data;
                if (!d) return;
                const rows = Object.keys(d.friendId)
                    .map((k) => Number(k))
                    .sort((a, b) => a - b)
                    .map((id) => ({
                        id,
                        username: d.friendInfo[id]?.username ?? '',
                        avatar: d.friendInfo[id]?.avatar ?? undefined,
                        remark: (d.friendId as Record<string, string | null>)[String(id)] ?? null,
                    }));
                setContacts((prev) => [...prev, ...rows]);
                cursorRef.current = d.nextAfter ?? cursorRef.current;
                setHasMore(Boolean(d.hasMore));
            })
            .catch((err: Error) => console.error('好友列表分页加载失败:', err.message))
            .finally(() => {
                loadingRef.current = false;
                setLoadingMore(false);
            });
    };

    // ─── 新朋友:同样走分页 + 虚拟列表(请求数也可能很多) ───
    const REQ_PAGE = 30;
    const [reqs, setReqs] = useState<Array<{ key: number; id: number; status: string; username?: string; avatar?: string }>>([]);
    const [reqHasMore, setReqHasMore] = useState(true);
    const [reqLoading, setReqLoading] = useState(false);
    const reqCursorRef = useRef(0);
    const reqLoadingRef = useRef(false);

    const loadReqPage = () => {
        if (reqLoadingRef.current || !reqHasMore) return;
        reqLoadingRef.current = true;
        setReqLoading(true);
        getFriendReqsPage(userId, reqCursorRef.current, REQ_PAGE)
            .then((res) => {
                const d = res.data as Record<string, unknown> | undefined;
                if (!d) return;
                const rows = Object.keys(d)
                    .filter((k) => k !== 'hasMore' && k !== 'nextBefore')
                    .map((k) => ({ key: Number(k), ...(d[k] as { id: number; status: string; username?: string; avatar?: string }) }))
                    // 后端按 friend_id 做 map key,JS 会把整数键升序重排,「最新在前」会丢;按行 id 倒序还原
                    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
                setReqs((prev) => [...prev, ...rows]);
                reqCursorRef.current = (d.nextBefore as number) ?? reqCursorRef.current;
                setReqHasMore(Boolean(d.hasMore));
            })
            .catch((err: Error) => console.error('好友请求分页加载失败:', err.message))
            .finally(() => {
                reqLoadingRef.current = false;
                setReqLoading(false);
            });
    };

    const pendingReqs = reqs.filter((r) => r.status === 'pending').length;
    // 首屏(对应分组展开时)拉第一页
    useEffect(() => {
        if (contactsOpen && contacts.length === 0) loadPage();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contactsOpen]);
    useEffect(() => {
        if (reqOpen && reqs.length === 0) loadReqPage();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reqOpen]);

    // 搜索:已加载的部分本地过滤(服务端搜索走「添加好友」那条链路)
    const visibleContacts = searchValue
        ? contacts.filter((c) => (c.remark || c.username).includes(searchValue))
        : contacts;

    // TSX
    return (
        <div className={`${directoryViewStyle.container} ${(activeFriend || activeReq || isCheckingFriendReq) ? directoryViewStyle.has_active : ''}`}>
            {/* 左侧 */}
            <div className={directoryViewStyle.left}>
                {/* 头部:搜索 + 切换添加好友(action 槽) */}
                <SearchHeader
                    onSearchChange={handleSearchChange}
                    placeholder={isAddingFriend ? t('directory.addSearchPlaceholder') : t('directory.searchPlaceholder')}
                    action={
                        <div className={directoryViewStyle.header_actions}>
                            <div
                                className={directoryViewStyle.left_header_add_user_container}
                                onClick={() => setAddMenuOpen((v) => !v)}
                            >
                                <i className={`iconfont icon-adduser ${directoryViewStyle.left_header_add_user}`}></i>
                            </div>
                            {addMenuOpen && (
                                <>
                                    <div className={directoryViewStyle.menuMask} onClick={() => setAddMenuOpen(false)} />
                                    <div className={directoryViewStyle.add_menu}>
                                        <button
                                            className={directoryViewStyle.add_menu_item}
                                            onClick={() => { setAddMenuOpen(false); setGroupModalOpen(true); }}
                                        >
                                            <i className="iconfont icon-contacts-fill" />
                                            <span>{t('group.entrance')}</span>
                                        </button>
                                        <button
                                            className={directoryViewStyle.add_menu_item}
                                            onClick={() => { setAddMenuOpen(false); handleClickAddFriend(); }}
                                        >
                                            <i className="iconfont icon-adduser" />
                                            <span>{t('directory.addFriend')}</span>
                                        </button>
                                    </div>
                                </>
                            )}
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
                                {/* 通讯录管理:微信列表顶部的整宽按钮;这里复用手搜号添加入口 */}
                                <div className={directoryViewStyle.manage_btn} onClick={handleClickAddFriend}>
                                    <i className="iconfont icon-adduser" />
                                    <span>{t('directory.manage')}</span>
                                </div>
                                {/* 新朋友:点整行展开/收起,展开后原地列出请求 */}
                                <div className={directoryViewStyle.group_row} onClick={() => setReqOpen(v => !v)}>
                                    <i className={reqOpen ? directoryViewStyle.chevron_down : directoryViewStyle.chevron_right} />
                                    <span>{t('directory.newFriend')}</span>
                                    {pendingReqs > 0 && <span className={directoryViewStyle.badge}>{pendingReqs}</span>}
                                </div>
                                {reqOpen && (
                                    <VirtualList
                                        items={reqs}
                                        itemHeight={48}
                                        className={directoryViewStyle.req_list}
                                        onReachEnd={loadReqPage}
                                        renderItem={(r) => (
                                            <div
                                                className={`${directoryViewStyle.req_row} ${activeReq?.key === r.key ? directoryViewStyle.req_row_active : ''}`}
                                                key={r.key}
                                                onClick={() => handleReqClick(r)}
                                            >
                                                <img
                                                    className={directoryViewStyle.req_avatar}
                                                    src={r.avatar ? buildServerUrl(r.avatar) : defaultAvatar}
                                                    alt=""
                                                />
                                                <span className={directoryViewStyle.req_name}>{r.username ?? ''}</span>
                                                {r.status === 'pending' ? (
                                                    <div className={directoryViewStyle.req_actions}>
                                                        <button className={directoryViewStyle.req_reject} onClick={() => handleReplyFriendReq(r.key, 'blocked')}>{t('directory.req.reject')}</button>
                                                        <button className={directoryViewStyle.req_accept} onClick={() => handleReplyFriendReq(r.key, 'accepted')}>{t('directory.req.accept')}</button>
                                                    </div>
                                                ) : (
                                                    <span className={directoryViewStyle.req_done}>
                                                        {r.status === 'accepted' ? t('directory.req.accepted') : t('directory.req.rejected')}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        footer={
                                            reqs.length === 0
                                                ? <div className={directoryViewStyle.empty_row}>{t('directory.noRequests')}</div>
                                                : reqLoading
                                                    ? <div className={directoryViewStyle.loading_row}>{t('common.loading')}</div>
                                                    : null
                                        }
                                    />
                                )}
                                {/* 联系人:展开后走虚拟列表;滚到底部自动取下一页 */}
                                <div className={directoryViewStyle.group_row} onClick={() => setContactsOpen(v => !v)}>
                                    <i className={contactsOpen ? directoryViewStyle.chevron_down : directoryViewStyle.chevron_right} />
                                    <span>{t('directory.contacts')}</span>
                                    <span className={directoryViewStyle.group_count}>
                                        {hasMore ? `${contacts.length}+` : contacts.length}
                                    </span>
                                </div>
                                {contactsOpen && (
                                    <VirtualList
                                        items={visibleContacts}
                                        itemHeight={44}
                                        className={directoryViewStyle.vlist}
                                        onReachEnd={loadPage}
                                        renderItem={(c) => (
                                            <DisplayItem
                                                key={c.id}
                                                id={String(c.id)}
                                                title={c.remark || c.username}
                                                content={''}
                                                compact
                                                isActive={!activeReq && activeFriend?.friendId === c.id}
                                                handleClick={() => handleFriendClick({ friendId: c.id, remark: c.remark })}
                                                avatar={c.avatar ? buildServerUrl(c.avatar) : defaultAvatar}
                                            />
                                        )}
                                        footer={loadingMore ? <div className={directoryViewStyle.loading_row}>{t('common.loading')}</div> : null}
                                    />
                                )}
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
                {/* 新朋友里选中的「非好友」:陌生人资料 + 添加到通讯录 */}
                {activeReq && !activeFriend && (
                    <AddFriendModal
                        inline
                        avatar={activeReq.avatar ? buildServerUrl(activeReq.avatar) : defaultAvatar}
                        username={activeReq.username ?? ''}
                        wxid={String(activeReq.key)}
                        region={t('directory.region')}
                        gender={(globalFriendInfoList[activeReq.key]?.gender as string) ?? ''}
                    />
                )}
                {/* 空态:微信右侧是淡色 Logo 水印,而不是一片空白 */}
                {!activeFriend && !activeReq && !isCheckingFriendReq && (
                    <div className={directoryViewStyle.empty_state}>
                        <i className="iconfont icon-message-fill" />
                    </div>
                )}
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
            {/* 发起群聊(勾选好友 → 建群 → 进入群会话) */}
            <CreateGroupModal
                open={groupModalOpen}
                userId={userId as number}
                friends={contacts.map((c) => ({
                    id: c.id,
                    name: c.remark || c.username,
                    avatar: c.avatar ? buildServerUrl(c.avatar) : defaultAvatar,
                }))}
                onClose={() => setGroupModalOpen(false)}
                onCreated={(convId) => { window.location.href = `/chat/${convId}`; }}
            />
        </div>
    )
}

export default DirectoryView;