import { useCallback, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../store/rootStore';
import { WebRTCManager } from '../utils/webrtc';
import { ensureIceServers } from '../utils/iceServers';
import { wsClient } from '../ws/wsClient';
// 通话状态
import {
  startCall,
  receiveCall,
  connectCall,
  reconnectingCall,
  restoreCall,
  updatePendingOffer,
  endCall,
  resetCall,
  setLocalStream,
  setRemoteStream,
  toggleMute as toggleMuteAction,
  updateDuration,
  setError,
} from '../store/callStore';
// 通话类型
import type { CallUser, CallType, CallAcceptEvent, CallRejectEvent, CallEndEvent, CallIceEvent, CallStartEvent, CallRejoinEvent, CallBusyEvent, CallHandledEvent, CallPeerReconnectingEvent, SessionDescription } from '../globalType/call';
import { saveActiveCall, loadActiveCall, clearActiveCall, type PersistedCall } from '../utils/callPersist';
import { App as AntdApp } from 'antd';

// wire 的 SessionDescription(type 为 string)适配为浏览器 RTCSessionDescriptionInit。
// type 在信令 wire 上即 'offer' | 'answer',故此处单个受控 cast 是安全的。
const toRtcSdp = (sd: SessionDescription): RTCSessionDescriptionInit => ({
  type: sd.type as RTCSdpType,
  sdp: sd.sdp,
});

// ── 模块级单例状态(与 wsClient 同模式)──
// 页面存在多个 useCall() 调用点(friendModal/callModal/chatView),每处都是独立 hook 实例;
// WebRTC 管理器与通话游标必须全局唯一,否则多实例各自建 PeerConnection、互抢信令
// (实测:通话中刷新后三实例各发一次 rejoin,answer 被其它实例的防重逻辑丢弃,重连失败;
//  监控日志出现两种 PC 状态交替即为多实例铁证)。
const webRTC = new WebRTCManager();
const processedEvents = new Set<string>();
const acceptSentIds = new Set<string>();
let currentCallId: string | null = null;
let reconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
let durationTimer: ReturnType<typeof setInterval> | null = null;
let rejoinAttempted = false;
let relayEscalated = false;
let escalateFn: (() => void) | null = null;


// 客户端重连宽限窗:ICE 中断后等待恢复的兜底时长,略大于服务端 grace(12s),让服务端先决断。
const RECONNECT_GRACE_MS = 15000;

// 通话会话核心(语音/视频共用):信令、WebRTC 协商、ICE、生命周期、计时全在这里,
// 与通话类型无关。类型差异只体现在「采集媒体是否取摄像头」与「邀请文案」两处,由 callState.callType 驱动;
// 渲染差异交给上层 VoiceCallPanel / VideoCallPanel,二者互不依赖。
export const useCall = () => {
  const { message } = AntdApp.useApp();
  const dispatch = useDispatch();
  const callState = useSelector((state: RootState) => state.call);//通话状态
  const currentUser = useSelector((state: RootState) => state.user);// 当前用户
  
  // 初始化WebRTC管理器(回调绑定到单例;组件卸载不销毁单例——它被多个调用点共享)
  useEffect(() => {
    const webrtc = webRTC;
    
    // 远程流回调：当收到远程音频流时触发
    webrtc.onRemoteStream = (stream) => {
      // 轨道：audio/video
      console.log('远程流轨道数量:', stream.getTracks().length);
      // 存到store，方便其他组件共享处理音频流
      dispatch(setRemoteStream(stream));
      // 媒体流到达 = 连接(或重连)实际建立(媒体经 DTLS,DTLS 完成即连接已通)。
      // 双保险:重连场景若 connectionState 回调丢失/延迟,UI 会卡在"重连中"——此处直接收敛为已连接。
      // connectCall 幂等:startTime 仅首次设置,重连不清零通话时长;首通时媒体到达亦代表连接建立。
      if (reconnectGraceTimer) { clearTimeout(reconnectGraceTimer); reconnectGraceTimer = null; }
      dispatch(connectCall());
      startDurationTimer();
    };
    
    // ICE候选回调：当收到ICE候选时触发
    // 注： onICECandidate 在webrtc.ts中设置，在这里定义业务逻辑
    webrtc.onICECandidate = (candidate) => {
      // 读取模块级最新 callId，避免闭包问题
      if (currentCallId) {
        console.log('生成ICE候选，发送给对端');
        // console.log('候选类型:', candidate.candidate?.split(' ')[7]); // host/srflx/relay等
        wsClient.send('call:ice', {
          callId: currentCallId, // 当前通话的id
          candidate, // ICE候选
        });
      } else {
        console.warn('收到ICE候选但没有活跃通话，忽略');
        console.log('当前callId:', currentCallId);
      }
    };
    
    // 连接状态变化回调
    webrtc.onConnectionStateChange = async (state) => {
      console.log('WebRTC连接状态变化:', state);

      if (state === 'connected') {
        // 连接(或重连)建立:清重连宽限定时器;connectCall 保留 startTime,重连不清零通话时长。
        if (reconnectGraceTimer) { clearTimeout(reconnectGraceTimer); reconnectGraceTimer = null; }
        dispatch(connectCall());
        startDurationTimer();
        message.success('通话已连接');
      } else if (state === 'connecting') {
        console.log('WebRTC正在建立连接...');
      } else if (state === 'failed' || state === 'disconnected') {
        // 中断不立即结束:进入 reconnecting 等对端 rejoin / 本端恢复;宽限超时仍未恢复才兜底结束。
        console.warn('WebRTC连接中断,进入重连等待:', state);
        // 自适应升级:首次 failed(而非临时 disconnected)且尚未升级过 → 升级为 relay-only 重连,
        // 强制媒体走能穿 VPN/对称NAT/严格防火墙的 TURN over TCP/TLS。grace 定时器仍作最终兜底。
        if (state === 'failed' && !relayEscalated && !webrtc.isForceRelay) {
          console.warn('P2P/直连失败,升级为 relay-only 重连');
          escalateFn?.();
        }
        dispatch(reconnectingCall());
        if (!reconnectGraceTimer) {
          reconnectGraceTimer = setTimeout(() => {
            reconnectGraceTimer = null;
            dispatch(setError('重连超时,通话结束'));
            message.error('重连超时,通话已结束');
            cleanup();
          }, RECONNECT_GRACE_MS);
        }
      }
    };
    
    // 错误回调
    webrtc.onError = (error) => {
      dispatch(setError(error.message));
      message.error(`通话错误: ${error.message}`);
    };

    return () => {
      // 单例不随组件卸载销毁(被 friendModal/callModal/chatView 多处共享);
      // 通话资源由通话状态机的 cleanup() 管理。
      stopDurationTimer();
    };
  }, []);

  // 实时信令事件监听(gateway /ws)
  useEffect(() => {
    // 收到通话邀请
    const handleCallStart = async (event: CallStartEvent) => {
      console.log('收到通话邀请:', event.callId);
      try {
        if (!currentUser) {
          throw new Error('用户未登录');
        }
        if (!event.from || !event.offer) return;
        // 更新store状态，保存offer,SDP保存在点击接受通话中处理
        const callType: CallType = event.callType === 'video' ? 'video' : 'voice';
        dispatch(receiveCall({
          callId: event.callId,
          localUser: {
            id: currentUser.id,
            username: currentUser.username,
            nickname: currentUser.nickname ?? '',
            avatar: currentUser.avatar ?? '',
          },
          remoteUser: event.from,
          offer: toRtcSdp(event.offer), // 保存offer
          callType,
        }));
        // 显示通话邀请
        message.info(`${event.from.nickname} 向您发起${callType === 'video' ? '视频' : '语音'}通话`);
      } catch (error) {
        console.error(' 处理通话邀请失败:', error);
        message.error('处理通话邀请失败');
      }
    };

    // 通话被接受
    const handleCallAccept = async (event: CallAcceptEvent) => {
      console.log('收到通话接受事件:', event.callId);
      // 重复处理检查
      if (processedEvents.has(`accept_${event.callId}`)) {
        console.log('重复的accept事件，跳过处理');
        return;
      }
      // 检查WebRTC状态，如果已经是stable说明已经处理过Answer
      if (webRTC?.getDetailedState()?.signalingState === 'stable') {
        console.log('WebRTC状态已是stable，跳过重复的Answer处理(多实例重复订阅嫌疑)', event.callId);
        return;
      }
      processedEvents.add(`accept_${event.callId}`); // 添加事件标记，防止重复处理
      console.log('通话被接受:', event.callId, '当前callId:', callState.callId);

      try {
        if (!webRTC) {
          console.error('WebRTC管理器不存在');
          return;
        }
        if (event.callId !== callState.callId) {
          console.warn('忽略无关的accept事件', { 
            eventCallId: event.callId, 
            currentCallId: callState.callId 
          });
          return;
        }

        // 详细状态检查和日志
        const state = webRTC.getDetailedState();
        console.log('处理Answer前的详细状态:', state);

        // 处理Answer
        // WebRTC标准允许在某些情况下状态可能不是严格的have-local-offer
        if (!event.answer) return;
        await webRTC.handleAnswer(toRtcSdp(event.answer));
        console.log('Answer处理完成，等待连接建立');
        
      } catch (error) {
        console.error('处理Answer失败:', error);
        dispatch(setError('连接建立失败: ' + (error as Error).message));
        message.error('连接建立失败');
        // 清理事件标记，允许重试
        processedEvents.delete(`accept_${event.callId}`);
      }
    };

    // 通话被拒绝
    const handleCallReject = (event: CallRejectEvent) => {
      console.log('通话被拒绝:', event.callId);
      if (event.callId === callState.callId) {
        dispatch(endCall()); // 结束通话
        message.info('对方拒绝了通话');
        cleanup(); // 清理通话资源
      }
    };

    // 通话结束
    const handleCallEnd = (event: CallEndEvent) => {
      if (event.callId === callState.callId) {
        dispatch(endCall());
        message.info('通话已结束');
        cleanup();
      }
    };

    // ICE候选交换
    const handleCallIce = async (event: CallIceEvent) => {
      try {
        if (!webRTC) {
          console.warn('WebRTC管理器不存在，忽略ICE候选');
          return;
        }
        
        if (event.callId !== callState.callId) {
          console.warn('ICE候选callId不匹配，忽略', {
            eventCallId: event.callId,
            currentCallId: callState.callId
          });
          return;
        }
        
        if (!event.candidate) return;
        console.log('候选类型:', event.candidate.candidate?.split(' ')[7]);
        await webRTC.addIceCandidate(event.candidate);
        console.log('ICE候选处理成功');
        
      } catch (error) {
        console.warn('处理ICE候选失败:', error);
        // ICE候选失败不应该中断通话，继续尝试其他候选
      }
    };

    // 对端刷新/断连后回来:收到其新 offer → 重置本端 PC、重取媒体、回 answer 完成重协商。
    const handleCallRejoin = async (event: CallRejoinEvent) => {
      if (!webRTC || event.callId !== callState.callId || !event.offer) {
        console.log('[rejoin-peer] 收到对端 rejoin 但忽略', {
          hasRtc: !!webRTC, eventCallId: event.callId, myCallId: callState.callId, hasOffer: !!event.offer,
        });
        return;
      }
      console.log('[rejoin-peer] 收到对端 rejoin,开始重协商');
      // 主叫刷新后重发新 offer,而本端是仍在振铃的被叫:仅替换 pendingOffer,等用户接听(不在此自动协商)。
      if (callState.status === 'ringing') {
        dispatch(updatePendingOffer(toRtcSdp(event.offer)));
        return;
      }
      try {
        dispatch(reconnectingCall());
        currentCallId = event.callId;
        // 对端因直连失败升级到 relay:本端同步切 relay-only —— 双方都只走中继才建得起来。
        // relay 是客户端内部信令提示(服务端原样转发),未进 IDL,故就地窄化读取。
        if ((event as CallRejoinEvent & { relay?: boolean }).relay) {
          relayEscalated = true;
          webRTC.setForceRelay(true);
        }
        // 建连前确保有最新 ICE servers(coturn STUN + 短期凭据 TURN);reset() 会用它重建 PeerConnection。
        await ensureIceServers();
        webRTC.reset(); // reset 保留本地流(重协商复用,不再重新采集媒体)
        await new Promise((r) => setTimeout(r, 200));
        // 仅在本地流确实缺失时(如接受来电后尚未采集)才重新 getUserMedia;
        // 通话中收到对端 rejoin 时流仍在,复用即可——重新采集会弹权限/设备忙,挂起重协商(实测根因)。
        if (!webRTC.localMediaStream) {
          const localStream = await webRTC.getUserMedia(callState.callType === 'video');
          dispatch(setLocalStream(localStream));
        }
        const answer = await webRTC.handleOffer(toRtcSdp(event.offer));
        wsClient.send('call:accept', {
          callId: event.callId,
          from: callState.localUser?.id,
          to: callState.remoteUser?.id,
          answer,
        });
      } catch (error) {
        console.error('处理对端重连失败:', error);
      }
    };

    // 主叫收到:被叫忙线(已在另一通通话中)。
    const handleCallBusy = (event: CallBusyEvent) => {
      if (event.callId !== callState.callId) return;
      message.info('对方忙线中');
      dispatch(endCall());
      cleanup();
    };

    // 本人其它设备/标签页已处理此来电(接听/拒接)→ 本端静默收起,不再振铃。
    const handleCallHandled = (event: CallHandledEvent) => {
      if (event.callId !== callState.callId) return;
      if (reconnectGraceTimer) { clearTimeout(reconnectGraceTimer); reconnectGraceTimer = null; }
      webRTC?.cleanup();
      stopDurationTimer();
      processedEvents.clear();
      acceptSentIds.clear();
      currentCallId = null;
      clearActiveCall();
      dispatch(resetCall());
    };

    // 服务端通知:对端掉线,处于 grace 重连窗。仅在通话中切到「重连中」;
    // 邀请期(ringing/calling)不切,保留来电/呼叫界面。
    const handlePeerReconnecting = (event: CallPeerReconnectingEvent) => {
      if (event.callId !== callState.callId) return;
      if (callState.status === 'connected' || callState.status === 'reconnecting') {
        dispatch(reconnectingCall());
      }
    };

    // 绑定事件监听器(wsClient.on 返回取消订阅函数,清理时逐个调用)
    const offStart = wsClient.on('call:start', handleCallStart);
    const offAccept = wsClient.on('call:accept', handleCallAccept);
    const offReject = wsClient.on('call:reject', handleCallReject);
    const offEnd = wsClient.on('call:end', handleCallEnd);
    const offIce = wsClient.on('call:ice', handleCallIce);
    const offRejoin = wsClient.on('call:rejoin', handleCallRejoin);
    const offBusy = wsClient.on('call:busy', handleCallBusy);
    const offHandled = wsClient.on('call:handled', handleCallHandled);
    const offPeerRec = wsClient.on('call:peer-reconnecting', handlePeerReconnecting);

    // 清理监听器
    return () => {
      console.log('清理 ws 事件监听器');
      processedEvents.clear();
      offStart();
      offAccept();
      offReject();
      offEnd();
      offIce();
      offRejoin();
      offBusy();
      offHandled();
      offPeerRec();
    };
  }, [callState.callId, callState.status, callState.callType, callState.localUser, callState.remoteUser, currentUser, dispatch]);

  // 同步callId到ref，避免ICE候选回调中的闭包问题
  useEffect(() => {
    currentCallId = callState.callId; // 同步callId到ref，避免ICE候选回调中的闭包问题
    console.log('callId已同步到ref:', callState.callId);
  }, [callState.callId]);// 依赖callId是唯一依赖

  // 开始计时
  const startDurationTimer = useCallback(() => {
    if (durationTimer) {
      clearInterval(durationTimer);
    }
    durationTimer = setInterval(() => {
      dispatch(updateDuration());
    }, 1000);
  }, [dispatch]);

  // 停止计时
  const stopDurationTimer = useCallback(() => {
    if (durationTimer) {
      clearInterval(durationTimer);
      durationTimer = null;
    }
  }, []);

  // 清理通话资源
  const cleanup = useCallback(() => {
    console.log('清理通话资源');
    if (reconnectGraceTimer) { clearTimeout(reconnectGraceTimer); reconnectGraceTimer = null; }
    clearActiveCall(); // 清持久化,刷新后不再误恢复
    stopDurationTimer();
    if (webRTC) {
      webRTC.cleanup();
    }
    dispatch(setLocalStream(null));
    dispatch(setRemoteStream(null));
    
    // 清理所有事件处理标记
    processedEvents.clear();
    acceptSentIds.clear();
    currentCallId = null;
    
    setTimeout(() => {
      dispatch(resetCall());
    }, 3000);
  }, [dispatch, stopDurationTimer]);

  // 发起通话
  const initiateCall = useCallback(async (targetUser: CallUser, callType: CallType = 'voice') => {
    console.log('发起通话给:', targetUser.username, '类型:', callType);

    try {
      if (!currentUser) {
        throw new Error('用户未登录');
      }

      if (!webRTC) {
        throw new Error('WebRTC服务不可用');
      }

      const callId = `call_${currentUser.id}_${targetUser.id}_${Date.now()}`;

      // 1. 先更新状态
      dispatch(startCall({
        callId,
        localUser: {
          id: currentUser.id,
          username: currentUser.username,
          nickname: currentUser.nickname ?? '',
          avatar: currentUser.avatar ?? '',
        },
        remoteUser: targetUser,
        callType,
      }));

      // 2. 重置WebRTC状态，确保干净开始
      console.log('重置WebRTC状态，确保干净的连接开始');
      // 新通话从默认(P2P 优先)开始;清掉上一通可能残留的 relay 升级标志。
      relayEscalated = false;
      webRTC.setForceRelay(false);
      // 建连前确保有最新 ICE servers(coturn STUN + 短期凭据 TURN);reset() 会用它重建 PeerConnection。
      await ensureIceServers();
      webRTC.reset();
      await new Promise(resolve => setTimeout(resolve, 200));

      // 3. 获取本地媒体流(视频通话同时取摄像头)
      console.log('获取本地媒体流...');
      const localStream = await webRTC.getUserMedia(callType === 'video');
      dispatch(setLocalStream(localStream));

      // 4. 创建offer (WebRTC管理器会自动处理轨道添加)
      console.log('创建通话请求(Offer)...');
      const offer = await webRTC.createOffer();
      
      // 5. 验证offer创建后的状态
      const stateAfterOffer = webRTC.getDetailedState();
      console.log('Offer创建后状态:', stateAfterOffer);
      
      if (stateAfterOffer?.signalingState !== 'have-local-offer') {
        throw new Error(`Offer创建后状态异常: ${stateAfterOffer?.signalingState}`);
      }

      // 6. 发送通话邀请
      // 注意：setLocalDescription后就会自动开始ICE候选收集
      // ICE候选会通过onicecandidate监听事件异步发送给对端
      console.log('发送通话邀请，ICE候选收集已启动');
      wsClient.send('call:start', {
        callId,
        from: {
          id: currentUser.id,
          username: currentUser.username,
          nickname: currentUser.nickname ?? '',
          avatar: currentUser.avatar ?? '',
        },
        to: targetUser,
        offer, // SDP 对象
        callType,
      });

      console.log('通话发起成功，等待对方接受');

    } catch (error) {
      console.error('发起通话失败:', error);
      const errorMessage = error instanceof Error ? error.message : '发起通话失败';
      dispatch(setError(errorMessage));
      message.error(errorMessage);
      cleanup();
    }
  }, [currentUser, dispatch, cleanup, message]);

  // 刷新/重载后重新入会:新建 PC、重取媒体、发新 offer,请对端重协商恢复连接。
  // 重连方永远是「发 offer」的一方(无论原先是主叫还是被叫),对端收到 call:rejoin 后回 answer。
  const rejoinCall = useCallback(async (persisted: PersistedCall, relayOnly = false) => {
    if (!webRTC || !currentUser) {
      console.warn('[rejoin] 前置条件不满足', { hasRtc: !!webRTC, hasUser: !!currentUser });
      return;
    }
    try {
      console.log('[rejoin] 步骤1: 开始重入会', persisted.callId, 'ws已连接=', wsClient.isConnected());
      currentCallId = persisted.callId;
      // relayOnly:直连失败后的升级重连,本端切 relay-only 并让对端也切(穿 VPN/对称NAT/防火墙)。
      if (relayOnly) {
        relayEscalated = true;
        webRTC.setForceRelay(true);
      }
      await ensureIceServers();
      webRTC.reset();
      await new Promise((resolve) => setTimeout(resolve, 200));
      console.log('[rejoin] 步骤2: reset 完成,开始采集媒体');
      const localStream = await webRTC.getUserMedia(persisted.callType === 'video');
      dispatch(setLocalStream(localStream));
      console.log('[rejoin] 步骤3: 媒体就绪,创建 offer');
      const offer = await webRTC.createOffer();
      const sent = wsClient.send('call:rejoin', {
        callId: persisted.callId,
        from: {
          id: currentUser.id,
          username: currentUser.username,
          nickname: currentUser.nickname ?? '',
          avatar: currentUser.avatar ?? '',
        },
        to: persisted.peer,
        offer,
        relay: relayOnly,
      });
      console.log('[rejoin] 步骤4: call:rejoin 发送', sent ? '成功' : '失败(WS 未连接,帧被丢弃!)');
      if (!sent) {
        // WS 未就绪时 send 静默丢弃:等连接建立后补发(刷新后 WS 重连可能晚于 rejoin 流程)
        const retry = () => {
          if (wsClient.isConnected()) {
            const ok = wsClient.send('call:rejoin', {
              callId: persisted.callId,
              from: {
                id: currentUser.id,
                username: currentUser.username,
                nickname: currentUser.nickname ?? '',
                avatar: currentUser.avatar ?? '',
              },
              to: persisted.peer,
              offer,
              relay: relayOnly,
            });
            console.log('[rejoin] WS 就绪后补发 call:rejoin:', ok ? '成功' : '仍失败');
            return ok;
          }
          setTimeout(retry, 500);
          return false;
        };
        setTimeout(retry, 500);
      }
    } catch (error) {
      console.error('[rejoin] 重新入会失败:', error);
      dispatch(setError('重连失败'));
      cleanup();
    }
  }, [currentUser, dispatch, cleanup]);

  // 直连失败 → 升级为 relay-only 重连。只有主叫重发 offer(带 relay 标记让对端也切 relay);
  // 被叫只本地切 relay,等主叫的 relay:rejoin 到来。每通只升一次。
  const escalateToRelay = useCallback(() => {
    if (relayEscalated || !webRTC || !callState.callId || !callState.remoteUser) return;
    const callerId = Number(callState.callId.split('_')[1]);
    const isCaller = callState.localUser?.id === callerId;
    relayEscalated = true;
    webRTC.setForceRelay(true);
    if (isCaller) {
      void rejoinCall({
        callId: callState.callId,
        peer: callState.remoteUser,
        callType: callState.callType,
        role: 'caller',
        status: 'connected',
        startTime: callState.startTime,
        isMuted: callState.isMuted,
        savedAt: Date.now(),
      }, true);
    }
  }, [callState.callId, callState.localUser, callState.remoteUser, callState.callType, callState.startTime, callState.isMuted, rejoinCall]);

  // 把最新 escalateToRelay 挂到 ref,供 mount 期 onConnectionStateChange 调用时拿到最新 callState。
  useEffect(() => {
    escalateFn = escalateToRelay;
  }, [escalateToRelay]);

  // 接受通话
  const acceptCall = useCallback(async () => {
    console.log('开始接受通话流程');
    
    try {
      if (!webRTC || !callState.callId || !callState.remoteUser) {
        throw new Error('通话状态异常');
      }

      // 恢复的来电(刷新后 pendingOffer 已失效):改由本端发新 offer 重新协商,而非复用旧 offer。
      // 对端(主叫,仍在呼叫中)收到 call:rejoin 走重建分支回 answer,双方重新收集 ICE 候选。
      if (!callState.pendingOffer) {
        dispatch(reconnectingCall());
        await rejoinCall({
          callId: callState.callId,
          peer: callState.remoteUser,
          callType: callState.callType,
          role: 'callee',
          status: 'connected',
          startTime: callState.startTime,
          isMuted: callState.isMuted,
          savedAt: Date.now(),
        });
        return;
      }

      // 1. 重置WebRTC状态，确保干净的开始
      console.log('重置WebRTC状态，确保干净的连接开始');
      // 接听方也从默认开始;若随后直连失败,由主叫驱动升级 relay。
      relayEscalated = false;
      webRTC.setForceRelay(false);
      await ensureIceServers();
      webRTC.reset();
      
      // 等待重置完成
      await new Promise(resolve => setTimeout(resolve, 200));
      console.log('WebRTC状态重置完成');

      // 2. 获取本地媒体流(视频通话同时取摄像头)
      const localStream = await webRTC.getUserMedia(callState.callType === 'video');
      dispatch(setLocalStream(localStream));
      console.log('本地媒体流获取成功');

      // 3. 状态检查
      const stateBefore = webRTC.getDetailedState();
      console.log('处理Offer前状态:', stateBefore);

      // 4. 处理offer并创建answer
      console.log('处理Offer并创建Answer...');
      const answer = await webRTC.handleOffer(callState.pendingOffer);

      // 5. 状态检查
      const stateAfter = webRTC.getDetailedState();
      console.log('创建Answer后状态:', stateAfter);

      // 6. 发送answer（防重复发送）
      const acceptKey = `accept_sent_${callState.callId}`;
      if (acceptSentIds.has(acceptKey)) {
        console.log('Answer已发送，跳过重复发送');
        return;
      }
      
      acceptSentIds.add(acceptKey);
      console.log('发送Answer给发起方');
      wsClient.send('call:accept', {
        callId: callState.callId,
        from: callState.localUser?.id,
        to: callState.remoteUser?.id,
        answer,
      });

      console.log('通话接受成功，等待连接建立');
      
    } catch (error) {
      console.error('接受通话失败:', error);
      const errorMessage = error instanceof Error ? error.message : '接受通话失败';
      dispatch(setError(errorMessage));
      message.error(errorMessage);
      cleanup();
    }
  }, [callState.callId, callState.pendingOffer, callState.localUser, callState.remoteUser, callState.callType, callState.startTime, callState.isMuted, rejoinCall, dispatch, cleanup, message]);

  // 拒绝通话
  const rejectCall = useCallback(() => {
    console.log('拒绝通话');
    
    if (callState.callId) {
      wsClient.send('call:reject', {
        callId: callState.callId,
      });
    }
    
    dispatch(endCall());
    cleanup();
  }, [callState.callId, dispatch, cleanup]);

  // 结束通话
  const terminateCall = useCallback(() => {
    console.log('结束通话');
    
    if (callState.callId) {
      wsClient.send('call:end', {
        callId: callState.callId,
      });
    }
    
    dispatch(endCall());
    cleanup();
  }, [callState.callId, dispatch, cleanup]);

  // 切换静音
  const toggleMute = useCallback(() => {
    if (webRTC) {
      const isMuted = webRTC.toggleMute();
      dispatch(toggleMuteAction());
      return isMuted;
    }
    return false;
  }, [dispatch]);

  // WebRTC状态监听
  useEffect(() => {
    if (webRTC) {
      const interval = setInterval(() => {
        const state = webRTC?.getDetailedState();
        if (state && callState.isActive) {
          console.log('WebRTC状态监控:', state);
        }
      }, 2000);
      
      return () => clearInterval(interval);
    }
  }, [callState.isActive]);

  // 刷新重载后:若有未过期的活跃通话持久化 → 按阶段恢复(仅一次)。
  // - ringing(被叫来电中):复原来电界面,等用户接听(接听时再重新协商,旧 offer 已失效)。
  // - calling(主叫呼叫中)/ connected(通话中):重发新 offer 重新协商。
  useEffect(() => {
    if (rejoinAttempted || !currentUser) return;
    rejoinAttempted = true;
    const persisted = loadActiveCall();
    if (!persisted) return;
    const localUser = {
      id: currentUser.id,
      username: currentUser.username,
      nickname: currentUser.nickname ?? '',
      avatar: currentUser.avatar ?? '',
    };
    const restoreStatus =
      persisted.status === 'ringing' ? 'ringing' : persisted.status === 'calling' ? 'calling' : 'reconnecting';
    dispatch(restoreCall({
      callId: persisted.callId,
      localUser,
      remoteUser: persisted.peer,
      callType: persisted.callType,
      status: restoreStatus,
      startTime: persisted.startTime,
      isMuted: persisted.isMuted,
    }));
    // ringing 不自动协商,等用户接听;calling/connected 立即重发 offer。
    if (persisted.status !== 'ringing') void rejoinCall(persisted);
  }, [currentUser, dispatch, rejoinCall]);

  // 邀请期(calling/ringing)与通话中(connected/reconnecting)都持久化精简上下文;结束/空闲清除。
  useEffect(() => {
    const s = callState.status;
    if (
      (s === 'calling' || s === 'ringing' || s === 'connected' || s === 'reconnecting') &&
      callState.callId && callState.localUser && callState.remoteUser
    ) {
      const callerId = Number(callState.callId.split('_')[1]);
      saveActiveCall({
        callId: callState.callId,
        peer: callState.remoteUser,
        callType: callState.callType,
        role: callState.localUser.id === callerId ? 'caller' : 'callee',
        status: s === 'calling' ? 'calling' : s === 'ringing' ? 'ringing' : 'connected',
        startTime: callState.startTime ?? null,
        isMuted: callState.isMuted,
      });
    } else if (s === 'idle' || s === 'ended') {
      clearActiveCall();
    }
  }, [callState.status, callState.callId, callState.isMuted, callState.startTime, callState.callType, callState.localUser, callState.remoteUser]);

  return {
    callState,
    initiateCall,
    acceptCall,
    rejectCall,
    terminateCall,
    toggleMute,
  };
};