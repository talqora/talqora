// 全局 socket 监听器，监听 socket 消息，并更新全局消息状态,在app.tsx中使用
import { useEffect, useRef} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import SocketService from '@/utils/socket';
import { addGlobalMessage, initGlobalUserConversations, initGlobalConversations,
initGlobalFriendList, initGlobalFriendInfoList, initLastMessages, addLastMessage, addConversation, addGlobalFriend, addGlobalFriendInfo } from '@/store/chatStore';
import type { Message } from '@/globalType/message';
import { getUserConversationList, getConversationList, getLastMessage } from '@/globalApi/chatApi';
import { getFriendList, getFriendReqs, searchUser } from '@/globalApi/friendApi';
import type { ApiResponse } from '@/globalType/apiResponse';
import type { UserConversation, Conversation } from '@/globalType/chat';
import type { FriendInfoList } from '@/globalType/friend';
import type { RootState } from '@/store/rootStore';
import { initFriendReqList, addFriendReq } from '@/store/friendStore';
import type { FriendReq } from '@/store/friendStore';
import messageSound from '@/assets/audios/message.wav';

export default function useGlobalMessageListener() {
    const userId = useSelector((state: RootState) => state.user.id);
    const dispatch = useDispatch();
    const socket = SocketService.getInstance();
    // 用于绑定从后端获取的最新值，避免闭包陷阱
    const globalConversationsRef = useRef<Record<string, Conversation>>({});
    const globalFriendInfoListRef = useRef<FriendInfoList>({});
    // 提示音 Audio 实例放进 ref，全生命周期只 new 一次：
    // 若直接写在组件体里，每次 render 都会重建一个 Audio 对象（浪费且无意义）。
    const audioRef = useRef<HTMLAudioElement | null>(null);
    if (audioRef.current === null) {
        audioRef.current = new Audio(messageSound);
    }
  // 注：不能使用这个用于下面获取会话列表，因为redux状态更新是异步的，不能保证在获取会话列表时，redux状态已经更新
  // const globalUserConversations = useSelector((state: RootState) => state.chat.globalUserConversations); // 从redux中获取全局用户会话列表
    // 注：这里监听的是全局消息，消息派发逻辑由后端实现，更新redux状态全局消息，同时触发组件重新渲染
    useEffect(() => { 
      // 首次启动应用先从后端获取会话列表和全局消息存到本地 
      // Promise 链式调用，比传统async/await更简洁，回调函数更是古代的写法
      // 获取用户会话列表
      getUserConversationList(userId).then(async (res1: ApiResponse<UserConversation[]>) => {
        await dispatch(initGlobalUserConversations(res1.data ?? [])); //注意需要await
        // 获取会话列表
        //注：必须使用最新的res1的值，redux更新是异步的，而且该组件获取的redux状态是初始值即使上面调用接口后更新了，这里的数据依然是旧的
        getConversationList(res1.data ?? []).then((res2: ApiResponse<Record<string, Conversation>>) => {
          globalConversationsRef.current = res2.data ?? {};
          dispatch(initGlobalConversations(res2.data ?? {}));
        });
        // 获取最后一条消息
        getLastMessage(res1.data ?? []).then((res3: ApiResponse<Record<string, Message>>) => {
          dispatch(initLastMessages(res3.data ?? {}));
        });
      });

      // 获取好友及好友信息列表
      getFriendList(userId).then(res => {
        if (!res.data) return;
        dispatch(initGlobalFriendList(res.data.friendId)); //返回好友id
        dispatch(initGlobalFriendInfoList(res.data.friendInfo)); //返回好友信息
        globalFriendInfoListRef.current = res.data.friendInfo ?? {};
    });
    // 获取好友请求
    getFriendReqs(userId).then(res => {
      dispatch(initFriendReqList(res.data ?? {}));
    });
  }, []);
  // dispatch依赖的解释：
  // React Hook 规则：useEffect 的依赖数组必须包含所有外部变量，不包含 dispatch，ESLint 会警告
  // dispatch通常是稳定的

  useEffect(() => {
       // 连接socket
       socket.connect();
       socket.emit('join', userId); // 发送连接事件，后端处理连接后的配置（加入会话等
       // 新消息处理函数
       const handleMessage = async (msg: Message) => {
            // setState 可以接受两种参数：
            // 直接值 ：setMessages(newMessages);
            // 函数式更新 ：注： 当某个会话是第一次收到消息时，其结构为[id] : undefined，需要使用空数组初始化
            // 注： 消息更新在chatView组件中，这里仅更新redux状态全局消息
            // setMessages((prev) => ({ ...prev, [msg.conversationId]: [...(prev[msg.conversationId] ?? []) , msg] }));
            dispatch(addGlobalMessage(msg)); //及时更新消息
            // 如果会话不存在，创建会话
            if(!globalConversationsRef.current[msg.conversationId]) {
              const splited = msg.conversationId.split('_');
              const otherUserId = splited[1] === userId.toString() ? splited[2] : splited[1];
              // const otherUserInfo = globalFriendInfoListRef.current[parseInt(otherUserId)];
              // 注：由于对方在回复好友请求后，需要用用户信息创建会话，而发起请求前获取的数据，不包含该用户信息
              const otherInfo = await searchUser({keyword: Number(otherUserId), userId});
              const otherUser = otherInfo.data?.friendInfo;
              if (!otherUser) {
                return;
              }
              // 如果好友也不存在，把好友也添加下
              if(!globalFriendInfoListRef.current[Number(otherUserId)]) {
                dispatch(addGlobalFriend({friendId: Number(otherUserId), remark: null}));
                dispatch(addGlobalFriendInfo({friendId: Number(otherUserId), friendInfo: otherUser}));
              }
              dispatch(addConversation({
                id: msg.conversationId,
                convType: 'single', // 单聊
                title: otherUser.username,
                avatar: otherUser.avatar,
                nextSeq: 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }));
            }
            dispatch(addLastMessage({ conversationId: msg.conversationId, message: msg }));
            // 消息提示音。注：大多数现代浏览器禁止在用户与页面交互（点击/键盘）之前自动播放音频
            audioRef.current?.play();
       };
       // 新好友请求处理
       const handleNewFriendReq = (friendReq: FriendReq) => {
        dispatch(addFriendReq(friendReq));
        audioRef.current?.play();
       }
       // 好友列表变化(如好友请求被同意):服务端推 friendListChanged → 重拉好友列表,即时刷新。
       const handleFriendListChanged = () => {
        getFriendList(userId).then(res => {
          if (!res.data) return;
          dispatch(initGlobalFriendList(res.data.friendId));
          dispatch(initGlobalFriendInfoList(res.data.friendInfo));
          globalFriendInfoListRef.current = res.data.friendInfo ?? {};
        });
       }
       // 仅监听 receiveMessage 事件，更新消息列表，消息派发逻辑由后端实现
        socket.on('receiveMessage', handleMessage);
        socket.on('receiveFriendReq', handleNewFriendReq);
        socket.on('friendListChanged', handleFriendListChanged);
       return () => {
          console.log('退出登录时，移除事件监听');
          socket.off('receiveMessage', handleMessage); // 退出登录时，移除事件监听
          socket.off('receiveFriendReq', handleNewFriendReq);
          socket.off('friendListChanged', handleFriendListChanged);
          socket.disconnect(); // 断开socket连接
          //注：在 socket.io-client 中，"disconnect" 是内置的保留事件名，内部自动管理，仅能.on 监听和使用它，不能.emit 和 .off
          // socket.emit('disconnect', { userId }); 
       };

  }, []);
  
}
