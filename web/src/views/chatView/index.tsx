import { useState, useEffect, useRef, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useNavigate, useParams } from 'react-router-dom';
import type { Conversation } from '@/globalType/chat';
import type { Message } from '@/globalType/message';
import { List } from 'antd';
import chatViewStyle from './style.module.scss';
import SocketService from '@/utils/socket';
import { getConversationMessages } from '@/globalApi/chatApi';
import { initGlobalMessages, initActiveConversation } from '@/store/chatStore';
import type { ApiResponse } from '@/globalType/apiResponse';
import type { RootState } from '@/store/rootStore';
import DisplayItem from '@/globalComponents/displayItem';
import SearchHeader from '@/globalComponents/searchHeader';
import FileUploader from '@/globalComponents/fileUploader';
import { useCall } from '@/hooks/useCall';
import type { CallUser, CallType } from '@/globalType/call';
import { buildServerUrl } from '@/utils/runtime';
import { defaultAvatar } from '@/assets/images';
import type { FileItem } from '@/utils/upload';
import ChatComposer, { type ComposerAction } from '@/globalComponents/chatComposer';
import MobileComposer, { type PanelAction } from '@/globalComponents/mobileComposer';
import ActionSheet from '@/globalComponents/actionSheet';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useLang } from '@/i18n';
import ProfileCard from '@/globalComponents/profileCard';

function ChatView() {

    const { t } = useLang();
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const isMobile = useIsMobile(); // 移动端聊天页用微信式头部栏 + 输入栏
    const { conversationId: routeConversationId } = useParams(); // 选中会话来自 URL(深链/返回可用)
    const activeConversation = useSelector((state: RootState) => state.chat.activeConversation); // 当前会话id(由 URL 同步)
    const messages = useSelector((state: RootState) => state.chat.globalMessages); //消息列表 注：数据结构为 { [conversationId: string]: Message[] , ... }
    const userId= useSelector((state: RootState) => state.user.id) as number; // 从redux中获取用户id
    const userAvatar = useSelector((state: RootState) => state.user.avatar); // 自己头像(渲染自己消息气泡用)
    // 注： RootState 类型是通过 ReturnType<typeof rootStore.getState> 推导出来的。
    // 但 redux-persist 的 persistReducer 会在 state 外层加上一些持久化相关的属性（如 _persist），
    // 导致类型变成 PersistPartial<RootState>，类型推断不再直接有 chat 属性(实际上能获取正确值，但类型推断报错)
    // 以下使用any类型，避免类型推断报错，但并非最佳实践
    const globalConversations = useSelector((state: RootState) => state.chat.globalConversations); // 从redux中获取全局会话列表
    const globalFriendInfoList = useSelector((state: RootState) => state.chat.globalFriendInfoList); // 从redux中获取全局好友信息列表
    const globalFriendList = useSelector((state: RootState) => state.chat.globalFriendList); // 好友备注表(friendId -> remark)
    const lastMessages = useSelector((state: RootState) => state.chat.lastMessages); // 从redux中获取最后一条消息
    // 展示名:有备注优先备注,否则用户名
    const friendDisplayName = (friendId: number) => globalFriendList[friendId] || globalFriendInfoList[friendId]?.username;
    const socket = SocketService.getInstance(); // 获取socket实例
    const [callSheetOpen, setCallSheetOpen] = useState(false); // 视频/语音通话选择弹层(移动端)
    const chatBodyRef = useRef<HTMLDivElement>(null); // 消息列表的ref，用来实现滚动
    // 点他人头像弹出的好友资料卡(fixed 定位 + 点击外部关闭)
    const [friendCard, setFriendCard] = useState<{ friendId: number; top: number; left: number } | null>(null);
    const friendCardRef = useRef<HTMLDivElement>(null);
    // const inputRef = useRef<HTMLTextAreaElement>(null); // 输入框的ref，用来实现滚动，注：antd组件已实现
    // 从localStorage（应用启动时已从后端中获取最新的会话列表和全局消息存到本地）中获取
    // useEffect(() => {
    //     //注：有上下级关系的数据，只监听上级，不能直接传入数组（可以传入引用、字段
    //     //如果 arr 是一个“每次渲染都新建的数组”，每次渲染都会生成新数组，会报错
    //     //引用：如果 arr 是 useState/useMemo/useCallback 得到的，引用只有在内容真正变化时才变：
    //     //总结：传入arr时需要保证是引用稳定的，否则会报错
    //     dispatch(setActiveConversation(null));
    // }, []); 

    // 获取会话消息（懒加载）
    // useCallback 固定引用：作为 prop 传给 memo 化的 DisplayItem，引用稳定 memo 才不会失效。
    const handleClickConversation = useCallback((conversationId: string) => {
        navigate(`/chat/${conversationId}`); // 仅改 URL,实际选中/拉取由下方 effect 统一处理
    }, [navigate]);
    // URL 是会话选中的单一入口:路由参数变 → 同步 Redux 当前会话 + 拉取消息。
    // 浏览器/移动端返回改变 URL,经此 effect 回灌 Redux,列表↔详情随之切换。
    useEffect(() => {
        dispatch(initActiveConversation(routeConversationId ?? null));
        if (!routeConversationId) return;
        getConversationMessages(routeConversationId).then((res: ApiResponse<Message[]>) => {
            dispatch(initGlobalMessages(res.data ?? []));
        });
    }, [routeConversationId, dispatch]);
    // 解析会话id，获取好友id
    const parseConversationId = (conversationId: string) => {
        const tp = conversationId.split('_');
        return parseInt(tp[1]===userId?.toString() ? tp[2] : tp[1]);
    };
    // 是否在该消息前显示时间分隔(首条 or 与上一条间隔 > 5 分钟)
    const msgTime = (m: Message) => new Date(m.timestamp || m.createdAt || '').getTime();
    const shouldShowTime = (msgs: Message[], i: number) => {
        if (i <= 0) return true;
        return msgTime(msgs[i]) - msgTime(msgs[i - 1]) > 5 * 60 * 1000;
    };
    const formatMsgTime = (m: Message) => {
        const d = new Date(m.timestamp || m.createdAt || '');
        if (isNaN(d.getTime())) return '';
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const now = new Date();
        return d.toDateString() === now.toDateString() ? hhmm : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
    };

    // 消息列表滚动条始终在底部
    useEffect(() => {
        // 注： ref不要绑定错了、一定要if判断存在，不然dom没渲染完成也会执行
        if (chatBodyRef.current) {
            // scrollTop：当前滚动条距离顶部的像素值（可读可写）
            // scrollHeight：内容总高度（只读）
            // clientHeight：可视区域高度（只读）
            chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight;
        }
    }, [messages, activeConversation]);

    // 点击外部关闭好友资料卡
    useEffect(() => {
        if (!friendCard) return;
        const onDown = (e: MouseEvent) => {
            if (friendCardRef.current && !friendCardRef.current.contains(e.target as Node)) setFriendCard(null);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [friendCard]);

    // 发送消息（文本由输入组件传入，草稿态不再驻留本组件）
    const sendMessage = (text: string) => {
        if (!text.trim() || !activeConversation) return;
        const msg:Message = {
            id: 0,
            clientMsgId: '',
            seq: 0,
            conversationId: activeConversation,
            senderId: userId,
            content: text,
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
        // 由 socket 监听 receiveMessage 事件来更新消息列表，这里不更新
    };
    const handleSearchChange = (value: string) => {
        console.log(value);
    }
    // 按钮点击事件
    const handleClickHeaderIcon = (method: string) => {
        switch(method) {
            case 'handleClickEmoji':
                handleClickEmoji();
                break;
            case 'handleClickFile':
                handleClickFile();
                break;
            case 'handleClickScreenshot':
                handleClickScreenshot();
                break;
            case 'handleClickChatRecord':
                handleClickChatRecord();
                break;
            case 'handleClickVoice':
                handleClickVoice();
                break;
            case 'handleClickVideo':
                handleClickVideo();
                break;
        }
    }
    // 表情
    const handleClickEmoji = () => {
        console.log('handleClickEmoji');
    }
    // 文件
    const [fileUploaderVisible, setFileUploaderVisible] = useState(false);
    const handleClickFile = () => {
        setFileUploaderVisible(true);
    }
    // 文件上传成功后发送消息
    const handleFileUploadSuccess = (files: FileItem[]) => {
        try {
            files.forEach(file => {
                const fileMessage: Message = {
                    id: 0,
                    clientMsgId: '',
                    seq: 0,
                    conversationId: activeConversation!,
                    senderId: userId,
                    content: t('chat.sentFile'),
                    type: 'file',
                    status: 'sent',
                    mentions: [],
                    isEdited: false,
                    isDeleted: false,
                    extra: {},
                    fileInfo: {
                        fileName: file.name,
                        fileSize: file.size,
                        fileUrl: file.url ?? '',
                        fileType: file.type || 'application/octet-stream',
                        fileMd5: file.md5 ?? ''
                    },
                    timestamp: new Date().toISOString(),
                    editHistory: [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                
                // 通过socket发送文件消息
                socket.emit('sendMessage', fileMessage);
            });            
        } catch (error) {
            console.error(t('chat.errors.uploadFailed'), error);
        }
        // 关闭文件上传弹窗
        setFileUploaderVisible(false);
    };
    // 截图
    const handleClickScreenshot = () => {
        console.log('handleClickScreenshot');
    }
    // 聊天记录
    const handleClickChatRecord = () => {
        console.log('handleClickChatRecord');
    }
    // 发起通话(语音/视频共用:取当前会话对方,再按类型发起)
    const startCallWithFriend = (callType: CallType) => {
        if (!activeConversation) {
            console.warn(t('chat.errors.noActiveConversation'));
            return;
        }
        const friendId = parseConversationId(activeConversation);
        const friendInfo = globalFriendInfoList[friendId];
        if (!friendInfo) {
            console.warn(t('chat.errors.noFriendInfo'));
            return;
        }
        const targetUser: CallUser = {
            id: friendId,
            username: friendInfo.username,
            nickname: friendDisplayName(friendId) || friendInfo.username,
            avatar: friendInfo.avatar
                ? buildServerUrl(friendInfo.avatar)
                : defaultAvatar,
        };
        initiateCall(targetUser, callType);
    };
    const handleClickVoice = () => startCallWithFriend('voice');
    const handleClickVideo = () => startCallWithFriend('video');

    // 渲染消息内容的函数
    const renderMessageContent = (msg: Message, isSelf: boolean) => {
        // 文件消息
        if (msg.type === 'file' && msg.fileInfo) {
            const { fileName = '', fileSize = 0, fileUrl = '', fileType = '' } = msg.fileInfo;
            
            // 格式化文件大小
            const formatFileSize = (bytes: number) => {
                if (bytes === 0) return '0 Bytes';
                const k = 1024;
                const sizes = ['Bytes', 'KB', 'MB', 'GB'];
                const i = Math.floor(Math.log(bytes) / Math.log(k));
                return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
            };

            // 根据文件类型显示不同内容
            if (fileType.startsWith('image/')) {
                return (
                    <div className={chatViewStyle.file_message}>
                        <img 
                            src={buildServerUrl(fileUrl)} 
                            alt={fileName}
                            style={{ maxWidth: '200px', maxHeight: '150px', borderRadius: '8px' }}
                            onClick={() => window.open(buildServerUrl(fileUrl), '_blank', 'noopener,noreferrer')}
                        />
                        <div className={chatViewStyle.file_info}>
                            <span>{fileName}</span>
                            <span>{formatFileSize(fileSize)}</span>
                        </div>
                    </div>
                );
            } else {
                return (
                    <div className={chatViewStyle.file_message}>
                        <div className={chatViewStyle.file_icon}>
                            <i className="iconfont icon-folder" style={{ fontSize: '24px' }}></i>
                        </div>
                        <div className={chatViewStyle.file_info}>
                            <div>{fileName}</div>
                            <div>{formatFileSize(fileSize)}</div>
                        </div>
                        <button 
                            onClick={() => {
                                const link = document.createElement('a');
                                link.href = buildServerUrl(fileUrl);
                                link.download = fileName;
                                document.body.appendChild(link);
                                link.click();
                                document.body.removeChild(link);
                            }}
                            className={chatViewStyle.download_btn}
                        >
                            {t('chat.download')}
                        </button>
                    </div>
                );
            }
        }
        
        // 文本消息
        return (
            <div className={`${chatViewStyle.bubble} ${isSelf ? chatViewStyle.bubbleSelf : chatViewStyle.bubbleOther}`}>
                {msg.content}
            </div>
        );
    };

    const { initiateCall } = useCall();

    // 给指定好友发起通话(语音/视频)
    const callFriend = (friendId: number, callType: CallType) => {
        const info = globalFriendInfoList[friendId];
        if (!info) return;
        const target: CallUser = {
            id: friendId,
            username: info.username,
            nickname: friendDisplayName(friendId) || info.username,
            avatar: info.avatar ? buildServerUrl(info.avatar) : defaultAvatar,
        };
        initiateCall(target, callType);
    };
    // 点他人头像 → 在头像右侧弹出其资料卡
    const openFriendCard = (friendId: number, e: React.MouseEvent) => {
        const r = e.currentTarget.getBoundingClientRect();
        setFriendCard({ friendId, top: Math.min(r.top, window.innerHeight - 280), left: r.right + 8 });
    };

    // 输入框顶部图标(左 4 + 右 2)
    const leftActions: ComposerAction[] = [
        { label: t('chat.iconLabels.emoji'),      icon: 'icon-meh',            method: 'handleClickEmoji' },
        { label: t('chat.iconLabels.file'),       icon: 'icon-folder',         method: 'handleClickFile' },
        { label: t('chat.iconLabels.screenshot'), icon: 'icon-scissor',        method: 'handleClickScreenshot' },
        { label: t('chat.iconLabels.record'),     icon: 'icon-comment',        method: 'handleClickChatRecord' },
    ];
    const rightActions: ComposerAction[] = [
        { label: t('chat.iconLabels.voice'),      icon: 'icon-phone',          method: 'handleClickVoice' },
        { label: t('chat.iconLabels.video'),      icon: 'icon-videocameraadd', method: 'handleClickVideo' },
    ];

    // 移动端 ＋ 面板(微信式 2×4 宫格);只有相册/视频通话接真实功能,其余占位
    const mobilePanelActions: PanelAction[] = [
        { label: t('chat.panel.album'),     icon: 'icon-image',            method: 'album' },
        { label: t('chat.panel.camera'),    icon: 'icon-camera',           method: 'camera' },
        { label: t('chat.panel.videoCall'), icon: 'icon-videocameraadd',   method: 'videoCall' },
        { label: t('chat.panel.location'),  icon: 'icon-location',         method: 'location' },
        { label: t('chat.panel.redPacket'), icon: 'icon-moneycollect-fill', method: 'redPacket' },
        { label: t('chat.panel.gift'),      icon: 'icon-gift-fill',        method: 'gift' },
        { label: t('chat.panel.transfer'),  icon: 'icon-swap',             method: 'transfer' },
        { label: t('chat.panel.voiceInput'), icon: 'icon-audio',           method: 'voiceInput' },
    ];
    const handleMobilePanel = (method: string) => {
        switch (method) {
            case 'album': handleClickFile(); break;
            // 视频通话:弹出「视频通话 / 语音通话」选择,而非直接发起(微信交互)
            case 'videoCall': setCallSheetOpen(true); break;
            default: console.log('[chat panel]', method); // 占位:拍摄/位置/红包/礼物/转账/语音输入/表情
        }
    };

    return (
        <div className={`${chatViewStyle.chat_view_container} ${activeConversation ? chatViewStyle.has_active : ''}`}>
            {/* 左侧：对话列表 */}
            <div className={chatViewStyle.chat_view_left}>
                <SearchHeader onSearchChange={handleSearchChange} placeholder={t('chat.searchPlaceholder')} />
                <div className={chatViewStyle.chat_view_left_body}>
                        {Object.values(globalConversations).map((item: Conversation) => (
                            <DisplayItem
                                key={item.id}
                                id={item.id}
                                avatar={globalFriendInfoList[parseConversationId(item.id)]?.avatar
                                    ? buildServerUrl(globalFriendInfoList[parseConversationId(item.id)]?.avatar ?? '')
                                    : defaultAvatar}
                                title={friendDisplayName(parseConversationId(item.id))}
                                content={lastMessages[item.id]?.content || ''}
                                time={lastMessages[item.id] ? formatMsgTime(lastMessages[item.id]) : undefined}
                                isActive={activeConversation === item.id}
                                handleClick={handleClickConversation}
                            />
                    ))}
                </div>
            </div>
            {/* 右侧：聊天窗口 */}
            <div className={chatViewStyle.chat_view_right}>
                {activeConversation ? (
                    <>
                        {/* 会话标题:移动端为 返回 / 居中标题 / ⋯ 三段栏(桌面端隐藏返回与⋯) */}
                        <div className={chatViewStyle.chat_header}>
                            <i className={chatViewStyle.back_btn} onClick={() => navigate('/chat')} />
                            <span className={chatViewStyle.chat_title}>{friendDisplayName(parseConversationId(activeConversation)) || ''}</span>
                            {/* ⋯ 暂不接功能,仅占位保持微信头部布局 */}
                            <i className={`iconfont icon-ellipsis ${chatViewStyle.more_btn}`} />
                        </div>
                        {/* 消息列表 */}
                        <div className={chatViewStyle.chat_body} ref={chatBodyRef}>
                            <List
                                className={chatViewStyle.message_list}
                                dataSource={messages}
                                renderItem={(msg: Message, index: number) => {
                                    const isSelf = msg.senderId === userId;
                                    const friendId = parseConversationId(activeConversation!);
                                    const avatarSrc = isSelf
                                        ? (userAvatar ? buildServerUrl(userAvatar) : defaultAvatar)
                                        : (globalFriendInfoList[friendId]?.avatar ? buildServerUrl(globalFriendInfoList[friendId].avatar) : defaultAvatar);
                                    return (
                                        <List.Item className={chatViewStyle.msg_item}>
                                            {shouldShowTime(messages, index) && (
                                                <div className={chatViewStyle.time_sep}>{formatMsgTime(msg)}</div>
                                            )}
                                            <div className={isSelf ? chatViewStyle.self_msg : chatViewStyle.other_msg}>
                                                <img
                                                    className={chatViewStyle.msg_avatar}
                                                    src={avatarSrc}
                                                    alt=""
                                                    onClick={isSelf ? undefined : (e) => openFriendCard(friendId, e)}
                                                />
                                                {renderMessageContent(msg, isSelf)}
                                            </div>
                                        </List.Item>
                                    )
                                }}
                            />
                        </div>
                        {/* 输入框:移动端用微信式输入栏 + ＋面板,桌面端用工具条 Composer */}
                        {isMobile ? (
                            <MobileComposer
                                onSend={sendMessage}
                                placeholder=""
                                panelActions={mobilePanelActions}
                                onActionClick={handleMobilePanel}
                            />
                        ) : (
                            <ChatComposer
                                onSend={sendMessage}
                                placeholder=""
                                leftActions={leftActions}
                                rightActions={rightActions}
                                onActionClick={handleClickHeaderIcon}
                                showSend={false}
                                inputRows={4}
                            />
                        )}
                    </>
                ) : (
                    <div className={chatViewStyle.no_chat}>{t('chat.noConversation')}</div>
                )}
                {/* 文件上传弹窗 */}
                {fileUploaderVisible && 
                <div className={chatViewStyle.file_uploader_container}>
                    <i className={`iconfont icon-close ${chatViewStyle.icon_close}`} onClick={() => setFileUploaderVisible(false)}></i>
                    <FileUploader
                    config={{
                        maxSize: 100 * 1024 * 1024,        // 最大文件大小：100MB
                        chunkSize: 5 * 1024 * 1024         // 分片大小：5MB（默认分片大小）
                    }}
                        multiple={false}                      // 单文件上传
                        onSuccess={handleFileUploadSuccess}            // 上传成功回调
                        // onError={handleError}                // 上传失败回调
                    />
                </div>
                }
            </div>
            {/* 视频/语音通话选择弹层(移动端点击 ＋面板「视频通话」弹出) */}
            <ActionSheet
                open={callSheetOpen}
                onClose={() => setCallSheetOpen(false)}
                items={[
                    { label: t('chat.panel.videoCall'), icon: 'icon-video', onClick: () => startCallWithFriend('video') },
                    { label: t('chat.panel.voiceCall'), icon: 'icon-phone', onClick: () => startCallWithFriend('voice') },
                ]}
            />
            {/* 点他人头像弹出的好友资料卡 */}
            {friendCard && (
                <div
                    className={chatViewStyle.friend_card}
                    style={{ top: friendCard.top, left: friendCard.left }}
                    ref={friendCardRef}
                >
                    <ProfileCard
                        avatar={globalFriendInfoList[friendCard.friendId]?.avatar ? buildServerUrl(globalFriendInfoList[friendCard.friendId].avatar ?? '') : ''}
                        name={globalFriendInfoList[friendCard.friendId]?.username || ''}
                        rows={[{ label: t('profile.wxid'), value: String(friendCard.friendId) }]}
                        actions={[
                            { key: 'msg', icon: 'icon-message', label: t('profile.sendMsg'), onClick: () => setFriendCard(null) },
                            { key: 'voice', icon: 'icon-phone', label: t('profile.voiceCall'), onClick: () => { callFriend(friendCard.friendId, 'voice'); setFriendCard(null); } },
                            { key: 'video', icon: 'icon-video', label: t('profile.videoCall'), onClick: () => { callFriend(friendCard.friendId, 'video'); setFriendCard(null); } },
                        ]}
                    />
                </div>
            )}
        </div>
    );
}

export default ChatView;