import { type ICECandidate } from '../globalType/call';
import { getIceServers } from './iceServers';

/**
 * 构建 RTCConfiguration。
 * ICE(Interactive Connectivity Establishment):整合 STUN/TURN 的 NAT 穿透框架,收集 host/srflx/relay
 * 候选并做连通性检查,确定双端可用的传输地址对。
 * iceServers 改为**运行时从服务端动态拉取**(见 utils/iceServers):自建 coturn 的 STUN + 带短期凭据的 TURN。
 * 不再硬编码 Google STUN——国内基本连不上、且无 TURN 兜底,异网络/对称 NAT(手机流量)会打不通。
 * 调用方须在建连前 `await ensureIceServers()`,本函数同步读取其缓存结果。
 */
function buildRtcConfiguration(): RTCConfiguration {
  return {
    iceServers: getIceServers(),
    iceCandidatePoolSize: 10, // 预生成 ICE 候选池
  };
}

/**
 * WebRTC 管理器类
 * 封装完整的WebRTC连接生命周期管理，包括：
 * - 媒体流获取
 * - 信令交换(SDP/ICE)
 * - 连接状态管理
 * - 错误处理和资源清理
 * 调用createOffer/handleOffer等方法进行信令交换
 */
export class WebRTCManager {
  // PeerConnection实例，WebRTC核心对象
  // 用于建立端到端（P2P）的多媒体通信连接。负责：
  // 媒体流（音频/视频）传输
  // 网络穿透（NAT/防火墙）
  // 信令协商（SDP/ICE）
  // 加密与带宽管理
  private peerConnection: RTCPeerConnection | null = null;
  
  // 本地媒体流(麦克风/摄像头)
  private localStream: MediaStream | null = null;
  
  // 远程媒体流(对方音视频)
  private remoteStream: MediaStream | null = null;
  
  // 暂存的ICE候选(用于在SDP交换完成前缓存候选)
  // 因为ice候选是基于sdp的，所以必须先确定sdp，再确定ice候选
  // 如果先确定ice候选，再确定sdp，会导致ice候选无法添加到peerConnection中
  private pendingIceCandidates: ICECandidate[] = [];
  
  // 状态标志
  private isNegotiating = false;  // 是否正在协商中
  
  // 收到远程媒体流时触发
  public onRemoteStream?: (stream: MediaStream) => void;
  
  // 生成ICE候选时触发(需要将候选发送给对端)
  public onICECandidate?: (candidate: ICECandidate) => void;
  
  // 连接状态变化时触发
  public onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  
  // 发生错误时触发
  public onError?: (error: Error) => void;

  constructor() {
    this.initialize();
  }

  private getLegacyGetUserMedia():
    | ((constraints: MediaStreamConstraints) => Promise<MediaStream>)
    | null {
    const legacyNavigator = navigator as Navigator & {
      getUserMedia?: (
        constraints: MediaStreamConstraints,
        successCallback: (stream: MediaStream) => void,
        errorCallback: (error: DOMException) => void
      ) => void;
      webkitGetUserMedia?: (
        constraints: MediaStreamConstraints,
        successCallback: (stream: MediaStream) => void,
        errorCallback: (error: DOMException) => void
      ) => void;
      mozGetUserMedia?: (
        constraints: MediaStreamConstraints,
        successCallback: (stream: MediaStream) => void,
        errorCallback: (error: DOMException) => void
      ) => void;
      msGetUserMedia?: (
        constraints: MediaStreamConstraints,
        successCallback: (stream: MediaStream) => void,
        errorCallback: (error: DOMException) => void
      ) => void;
    };

    const getUserMedia =
      legacyNavigator.getUserMedia ||
      legacyNavigator.webkitGetUserMedia ||
      legacyNavigator.mozGetUserMedia ||
      legacyNavigator.msGetUserMedia;

    if (!getUserMedia) {
      return null;
    }

    return (constraints: MediaStreamConstraints) =>
      new Promise((resolve, reject) => {
        getUserMedia.call(legacyNavigator, constraints, resolve, reject);
      });
  }

  /**
   * 确保PeerConnection实例存在
   * 如果被cleanup清理过，会自动重新初始化
   * 这是一个关键的防御性方法，避免使用null的peerConnection
   */
  private ensurePeer(): void {
    if (!this.peerConnection || this.peerConnection.connectionState === 'closed') {
      console.log('PeerConnection不存在或已关闭，重新初始化');
      this.initialize();
    }
  }

  /**
   * 初始化WebRTC连接
   * 创建RTCPeerConnection实例并设置事件监听器
   * 这是WebRTC连接的第一步，必须在其他操作前调用
   * @throws 初始化失败会触发onError回调
   */
  private initialize() {
    try {
      console.log('初始化WebRTC连接');
      
      // 创建PeerConnection实例，传入配置
      this.peerConnection = new RTCPeerConnection(buildRtcConfiguration());
      
      // 设置所有必要的事件监听器
      this.setupEventHandlers();
      
    } catch (error) {
      console.error('WebRTC初始化失败:', error);
      this.handleError(new Error('WebRTC初始化失败'));
    }
  }


  /**
   * 设置PeerConnection的所有事件监听器
   * WebRTC通过事件驱动模型工作，这里设置了:
   * 1. ICE候选生成事件
   * 2. 远程媒体流到达事件
   * 3. 连接状态变化事件
   * 4. ICE连接状态事件
   * 5. 重新协商事件
   * 
   * 注意：这些事件处理函数会在整个连接生命周期中被多次调用
   */
  private setupEventHandlers() {
    if (!this.peerConnection) return;

    /**
     * ICE候选生成事件
     * 当发现新的ICE候选(网络路径)时触发
     * 当 event.candidate 为 null 时，表示候选收集完成
     * 需要将候选通过信令服务器发送给对端
     */
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('生成ICE候选');
        // 将原生候选转换为ICECandidate对象，方便后续处理
        const candidate: ICECandidate = {
          candidate: event.candidate.candidate, // 候选
          sdpMlineIndex: event.candidate.sdpMLineIndex ?? undefined, // 候选所在的SDP轨道索引
          sdpMid: event.candidate.sdpMid ?? undefined, // 候选所在的SDP轨道ID
        };
        this.onICECandidate?.(candidate);// 将候选通过信令服务器发送给对端
      }
    };

    /**
     * 远程媒体流到达事件
     * ontrack 是RTCPeerConnection 对象的一个关键事件处理器，接收远程媒体流（音频/视频）的轨道（Track）
        触发时机：当远程对端通过 addTrack() 或 addTransceiver() 添加媒体轨道，并成功建立连接后，本地会通过 ontrack 接收到这些轨道。
        核心功能：将远程的音频/视频数据绑定到本地媒体元素（如 <video> 或 <audio> ）进行播放或处理
        底层工作原理
          轨道协商：
          对端通过 SDP 协商确定支持的媒体类型（如 H.264 视频或 Opus 音频）。
          本地 ontrack 在收到轨道数据后自动触发。
          媒体流关联：一个 MediaStream 可包含多个轨道（如同时传输音频和视频）。通过 streams 数组可获取轨道所属的完整流上下文。
          传输控制：transceiver.direction 可动态调整轨道方向（如 sendrecv 、 recvonly ）
     * 当收到对端的音视频流时触发
     * 通常在这里将流绑定到video/audio元素
     */
    this.peerConnection.ontrack = (event) => {
      console.log('收到远程流');
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0];
        this.onRemoteStream?.(this.remoteStream);
      }
    };

    /**
     * 连接状态变化事件
     * 监控连接状态变化：new/connecting/connected/disconnected/failed/closed
     * 标准处理：只在failed时清理，disconnected给浏览器恢复机会
     */
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log('WebRTC连接状态变化:', state);
      
      if (state) {
        this.onConnectionStateChange?.(state);
        
        // 只在真正失败时清理，不要在disconnected时立即清理
        // disconnected可能是临时网络波动，浏览器会尝试重连
        if (state === 'failed') {
          console.error('WebRTC连接失败，开始清理资源');
          setTimeout(() => this.cleanup(), 1000);
        } else if (state === 'connected') {
          console.log('WebRTC连接建立成功');
        }
      }
    };

    /**
     * ICE连接状态事件
     * 监控ICE连接状态：new/checking/connected/completed/failed/disconnected/closed
     */
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      console.log('ICE连接状态变化:', state);
      
      // 详细记录ICE状态变化，便于调试网络连接问题
      switch (state) {
        case 'checking':
          console.log('ICE正在检查连接路径...');
          break;
        case 'connected':
          console.log('ICE连接建立，开始媒体传输');
          break;
        case 'completed':
          console.log('ICE连接完成，找到最佳路径');
          break;
        case 'failed':
          console.error('ICE连接失败，可能需要TURN服务器');
          break;
        case 'disconnected':
          console.warn('ICE连接断开，尝试重连中...');
          break;
      }
    };

    /**
     * ICE收集状态事件
     * 监控ICE候选收集过程：new/gathering/complete
     */
    this.peerConnection.onicegatheringstatechange = () => {
      const state = this.peerConnection?.iceGatheringState;
      console.log('ICE收集状态:', state);
    };

    /**
     * ICE候选错误事件
     * 当STUN/TURN服务器出现问题时触发
     */
    this.peerConnection.onicecandidateerror = (event: RTCPeerConnectionIceErrorEvent) => {
      console.error('ICE候选错误:', {
        errorCode: event.errorCode,
        errorText: event.errorText,
        url: event.url
      });
    };

    /**
     * 重新协商事件
     * 当需要重新协商SDP时触发(如添加/删除轨道)
     */
    this.peerConnection.onnegotiationneeded = () => {
      console.log('检测到协商需求，可能需要重新创建Offer');
      // 注意：在Perfect Negotiation模式下才自动处理重协商
      // 当前简单模式下，由应用层控制协商时机
    };
  }

  //获取用户媒体
  /**
   * 获取用户媒体流(麦克风)
   * 请求用户麦克风权限并获取音频流
   * 这是WebRTC通话的必要前置步骤
   * @returns {Promise<MediaStream>} 包含音频轨道的媒体流
   * @throws 如果用户拒绝权限或设备不可用
   * 注意：
   * 1. 必须在安全上下文(HTTPS/localhost)中调用
   * 2. 浏览器会显示权限请求弹窗
   * 3. 配置了回声消除/降噪等音频处理参数
   */
  async getUserMedia(withVideo = false): Promise<MediaStream> {
    try {
      console.log(withVideo ? '请求麦克风+摄像头权限' : '请求麦克风权限');

      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,   // 启用回声消除
          noiseSuppression: true,   // 启用降噪
          autoGainControl: true,    // 启用自动增益控制
          sampleRate: 44100,        // 设置采样率(CD音质)
        },
        // 视频通话才请求摄像头;前置摄像头、720p 目标分辨率(由浏览器按能力协商)
        video: withVideo
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
          : false,
      };

      const modernGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
      const legacyGetUserMedia = this.getLegacyGetUserMedia();

      if (!modernGetUserMedia && !legacyGetUserMedia) {
        const isLocalhost =
          window.location.hostname === 'localhost' ||
          window.location.hostname === '127.0.0.1';

        if (!window.isSecureContext && !isLocalhost) {
          throw new Error(
            '当前页面不是安全上下文。手机通过局域网 HTTP 地址访问时，浏览器通常会禁用麦克风。请改用 localhost、HTTPS，或在浏览器中使用受信任的安全来源。'
          );
        }

        throw new Error('当前浏览器不支持 getUserMedia，无法获取麦克风音频流');
      }

      // 优先使用标准API，老浏览器再回退到历史实现
      const stream = modernGetUserMedia
        ? await modernGetUserMedia(constraints)
        : await legacyGetUserMedia!(constraints);
      
      console.log('获取音频流成功');
      this.localStream = stream;    // 保存到实例变量
      return stream;
    } catch (error) {
      console.error('获取音频流失败:', error);
      
      // 详细错误处理
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          throw new Error('麦克风权限被拒绝，请在浏览器设置中允许麦克风访问');
        } else if (error.name === 'NotFoundError') {
          throw new Error('未找到麦克风设备，请检查硬件连接');
        } else if (error.name === 'NotReadableError') {
          throw new Error('麦克风被其他应用占用，请关闭其他音频应用');
        } else if (error.name === 'SecurityError') {
          throw new Error('当前页面不满足浏览器的安全要求，无法访问麦克风。请改用 HTTPS 或 localhost。');
        }
      }
      
      throw new Error('无法获取麦克风权限，请检查浏览器设置和硬件连接');
    }
  }

  // 创建offer
  /**
   * 创建Offer(发起方)
   * WebRTC信令流程的第一步
   * 1. 确保PeerConnection可用
   * 2. 添加本地媒体轨道
   * 3. 创建标准SDP Offer(不使用废弃的约束)
   * 4. 设置本地描述(这会触发ICE收集)
   * @returns {Promise<RTCSessionDescriptionInit>} 生成的Offer SDP
   * @throws 如果PeerConnection不可用或创建失败
   * 标准化改进：
   * 1. 移除废弃的offerToReceiveAudio/Video约束
   * 2. 使用ensurePeer确保连接可用
   * 3. 返回实际的localDescription而非原始offer
   */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    // 使用ensurePeer替代手动检查，更可靠
    this.ensurePeer();
    
    if (!this.peerConnection) {
      throw new Error('无法创建PeerConnection实例');
    }

    try {
      console.log('开始创建Offer');
      console.log('初始信令状态:', this.peerConnection.signalingState);
      
      // 添加本地媒体轨道(标准做法：在createOffer前添加)
      if (this.localStream) {
        console.log('添加本地音频流到PeerConnection');
        
        const existingSenders = this.peerConnection.getSenders();
        console.log('现有发送者数量:', existingSenders.length);
        
        // 避免重复添加相同轨道
        this.localStream.getTracks().forEach(track => {
          const existingSender = existingSenders.find(sender => sender.track === track);
          
          if (!existingSender && this.peerConnection) {
            this.peerConnection.addTrack(track, this.localStream!);
            console.log(`${track.kind}轨道已添加到PeerConnection`);
          } else {
            console.log(`${track.kind}轨道已存在，跳过添加`);
          }
        });
      } else {
        console.warn('没有本地流，将只接收远端音频');
        // 可选：添加仅接收的transceiver
        // this.peerConnection.addTransceiver('audio', { direction: 'recvonly' });
      }

      // 标记协商开始
      this.isNegotiating = true;
      
      // 创建标准Offer(不使用废弃的约束参数)
      console.log('开始创建标准Offer SDP...');
      const offer = await this.peerConnection.createOffer();
      
      console.log('Offer创建完成，设置本地描述...');
      
      // 设置本地描述，这会触发ICE候选收集
      await this.peerConnection.setLocalDescription(offer);
      
      // 验证设置后的状态
      const finalState = this.peerConnection.signalingState;
      console.log('本地描述设置成功');
      console.log('最终信令状态:', finalState);
      
      // 状态检查：设置Offer后应该是have-local-offer
      if (finalState !== 'have-local-offer') {
        throw new Error(`Offer设置后状态异常: ${finalState}, 期望: have-local-offer`);
      }
      
      console.log('Offer创建流程完成，等待ICE候选收集...');
      
      // 返回实际的localDescription，它可能被浏览器标准化处理过
      return this.peerConnection.localDescription!;
      
    } catch (error) {
      console.error('创建Offer失败:', error);
      this.isNegotiating = false;
      throw new Error('创建通话请求失败: ' + (error as Error).message);
    }
  }

  // 处理offer并创建answer
  /**
   * 处理收到的Offer(应答方)
   * 标准信令流程的第二步，遵循正确时序：
   * 1. 确保PeerConnection可用
   * 2. 设置远程Offer描述
   * 3. 添加本地媒体轨道
   * 4. 创建Answer SDP
   * 5. 设置本地描述(触发ICE收集)
   * 6. 处理暂存的ICE候选
   * 
   * @param {RTCSessionDescriptionInit} offer - 对端发来的Offer SDP
   * @returns {Promise<RTCSessionDescriptionInit>} 生成的Answer SDP
   * @throws 处理失败
   */
  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    // 确保PeerConnection实例可用
    this.ensurePeer();
    
    if (!this.peerConnection) {
      throw new Error('无法创建PeerConnection实例');
    }

    try {
      console.log('开始处理收到的Offer');
      console.log('处理前信令状态:', this.peerConnection.signalingState);
      
      // 1. 设置远程Offer描述
      await this.peerConnection.setRemoteDescription(offer);
      console.log('远程Offer描述设置成功');
      console.log('设置后信令状态:', this.peerConnection.signalingState);
      console.log('设置后连接状态:', this.peerConnection.connectionState);
      
      // 注意：setRemoteDescription后connectionState为'new'是正常的
      // ICE连接建立需要双方交换完SDP和ICE候选后才开始
      // connectionState变化顺序: new -> connecting -> connected
      
      // 2. 添加本地媒体轨道(如果存在)
      if (this.localStream) {
        console.log('添加本地音频流到PeerConnection');
        
        this.localStream.getTracks().forEach(track => {
          const existingSender = this.peerConnection!.getSenders().find(s => s.track === track);
          if (!existingSender) {
            this.peerConnection!.addTrack(track, this.localStream!);
            console.log(`${track.kind}轨道已添加到PeerConnection`);
          } else {
            console.log(`${track.kind}轨道已存在，跳过添加`);
          }
        });
        
        console.log('本地流轨道总数:', this.localStream.getTracks().length);
      } else {
        console.warn('没有本地流，将只接收远端音频');
      }
      
      // 3. 创建Answer SDP
      console.log('开始创建Answer SDP...');
      const answer = await this.peerConnection.createAnswer();
      
      console.log('Answer创建完成，设置本地描述...');
      
      // 4. 设置本地Answer描述(触发ICE候选收集)
      await this.peerConnection.setLocalDescription(answer);
      
      console.log('本地Answer描述设置成功');
      console.log('最终信令状态:', this.peerConnection.signalingState);
      console.log('最终连接状态:', this.peerConnection.connectionState);
      
      // 5. 处理之前暂存的ICE候选
      await this.processPendingIceCandidates();
      
      console.log('Answer处理流程完成，等待ICE连接建立...');
      
      // 返回实际的localDescription
      return this.peerConnection.localDescription!;
      
    } catch (error) {
      console.error('处理Offer失败:', error);
      throw new Error('处理通话请求失败: ' + (error as Error).message);
    }
  }

  // 处理answer
  /**
   * 处理收到的Answer(发起方)
   * 信令流程的最后一步，完成SDP协商：
   * 1. 确保PeerConnection可用
   * 2. 验证当前状态和Answer有效性
   * 3. 设置远程Answer描述
   * 4. 处理暂存的ICE候选
   * 5. 标记协商完成
   * 
   * @param {RTCSessionDescriptionInit} answer - 对端发来的Answer SDP
   * @throws 如果状态异常或处理失败
   */
  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    // 确保PeerConnection可用
    this.ensurePeer();
    
    if (!this.peerConnection) {
      throw new Error('无法创建PeerConnection实例');
    }

    try {
      console.log('开始处理收到的Answer');
      console.log('处理前信令状态:', this.peerConnection.signalingState);
      console.log('Answer类型:', answer.type);
      console.log('Answer SDP长度:', answer.sdp?.length);
      
      // 验证Answer有效性
      if (!answer || answer.type !== 'answer') {
        throw new Error(`无效的Answer: type=${answer?.type}`);
      }

      // 状态检查：理想情况下应该是have-local-offer
      const currentState = this.peerConnection.signalingState;
      if (currentState === 'stable') { //fiexd2：跳过stable
        console.warn(`信令状态已是stable，Answer可能已经处理过，跳过重复处理`);
        return; // 如果已经是stable，说明Answer已经处理过了
      } else if (currentState !== 'have-local-offer') {
        console.warn(`信令状态不是预期的have-local-offer，当前: ${currentState}`);
        // 对于其他非预期状态，继续尝试处理
      }

      // 设置远程Answer描述
      console.log('设置远程Answer描述...');
      await this.peerConnection.setRemoteDescription(answer);
      
      console.log('Answer设置成功');
      console.log('设置后信令状态:', this.peerConnection.signalingState);
      console.log('设置后连接状态:', this.peerConnection.connectionState);
      
      // 处理之前暂存的ICE候选
      await this.processPendingIceCandidates();
      
      // 标记协商完成
      this.isNegotiating = false;
      
      console.log('Answer处理完成，SDP协商结束，等待ICE连接...');
      
    } catch (error) {
      console.error('处理Answer失败:', error);
      this.isNegotiating = false;
      throw new Error('建立连接失败: ' + (error as Error).message);
    }
  }

  //添加ice候选
  /**
   * 添加ICE候选
   * 将对端发来的ICE候选添加到PeerConnection中
   * 如果PeerConnection未准备好，候选会被暂存
   * 
   * @param {ICECandidate} candidate - ICE候选对象
   * 
   * 注意：
   * 1. ICE候选用于建立P2P连接路径
   * 2. 候选可能在SDP交换前到达，需要暂存
   * 3. 候选添加顺序不影响连接建立
   */
  async addIceCandidate(candidate: ICECandidate): Promise<void> {
    if (!this.peerConnection) {
      console.warn('PeerConnection未初始化，暂存ICE候选');
      this.pendingIceCandidates.push(candidate);
      return;
    }

    // 如果远程描述未设置，暂存候选(等待setRemoteDescription)
    if (!this.peerConnection.remoteDescription) {
      console.log('远程描述未设置，暂存ICE候选');
      this.pendingIceCandidates.push(candidate);
      return;
    }

    try {
      // 将候选转换为RTCIceCandidate对象
      const rtcCandidate = new RTCIceCandidate({
        candidate: candidate.candidate,
        sdpMLineIndex: candidate.sdpMlineIndex,
        sdpMid: candidate.sdpMid,
      });
      
      // 添加候选到PeerConnection
      await this.peerConnection.addIceCandidate(rtcCandidate);
      console.log('ICE候选添加成功');
    } catch (error) {
      console.warn('添加ICE候选失败:', error);
    }
  }

  // 处理ICE候选
  /**
   * 处理暂存的ICE候选
   * 在远程描述设置完成后，处理之前暂存的所有ICE候选
   * 
   * 注意：
   * 1. 通常在setRemoteDescription后调用
   * 2. 按接收顺序处理候选
   * 3. 处理完成后清空暂存列表
   */
  private async processPendingIceCandidates(): Promise<void> {
    if (this.pendingIceCandidates.length === 0) return;
    
    console.log(`处理${this.pendingIceCandidates.length}个暂存的ICE候选`);
    
    // 按顺序处理所有暂存候选
    for (const candidate of this.pendingIceCandidates) {
      await this.addIceCandidate(candidate);
    }
    
    // 清空暂存列表
    this.pendingIceCandidates = [];
  }

  // 切换静音
  /**
   * 切换本地音频轨道的启用状态
   * @returns {boolean} 切换后的静音状态(true表示静音)
   * 注意：
   * 2. 对端会收到静音通知(onmute事件)
   */
  toggleMute(): boolean {
    if (!this.localStream) return false;
    
    // 获取第一个音频轨道(通常只有一个)
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      // 切换轨道启用状态
      audioTrack.enabled = !audioTrack.enabled;
      console.log('静音状态:', !audioTrack.enabled);
      return !audioTrack.enabled;
    }
    return false;
  }

  // 获取连接状态
  /**
   * 获取连接统计信息
   * 返回包含各种连接指标的统计报告，可用于：
   * - 监控连接质量
   * - 诊断网络问题
   * - 显示带宽/延迟等指标
   * 
   * @returns {Promise<RTCStatsReport | null>} 统计报告对象
   */
  async getStats(): Promise<RTCStatsReport | null> {
    if (!this.peerConnection) return null;
    return await this.peerConnection.getStats();
  }

  /**
   * 清理WebRTC资源
   * 1. 停止所有媒体轨道
   * 2. 关闭PeerConnection
   * 3. 重置所有状态
   * 
   * 注意：
   * 1. 应该在通话结束或连接失败时调用
   * 2. 调用后需要重新initialize才能再次使用
   * 3. 会触发所有轨道的onended事件
   */
  cleanup(): void {
    console.log('清理WebRTC资源');
    
    // 停止并释放本地媒体流
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        track.stop();  // 停止轨道(触发onended)
        console.log('停止音频轨道');
      });
      this.localStream = null;
    }

    // 关闭PeerConnection
    if (this.peerConnection) {
      this.peerConnection.close(); // 触发oniceconnectionstatechange
      this.peerConnection = null;
    }

    // 重置所有状态
    this.remoteStream = null;
    this.pendingIceCandidates = [];
    this.isNegotiating = false;
  }

  /**
   * 重置WebRTC连接
   * 先清理现有资源，然后重新初始化
   * 用于处理连接失败或需要重新建立连接的场景
   * 
   * 注意：
   * 1. 会触发所有状态回调
   * 2. 媒体权限需要重新获取
   */
  reset(): void {
    this.cleanup();      // 先清理
    this.initialize();   // 再初始化
  }

  /**
   * 错误处理
   * 统一处理WebRTC相关错误，包括：
   * 1. 记录错误日志
   * 2. 触发onError回调
   * 
   * @param {Error} error - 错误对象
   */
  private handleError(error: Error): void {
    console.error('WebRTC错误:', error);
    this.onError?.(error);
  }

  // ========== 状态获取方法 ==========  
  // 是否已建立连接
  get isConnected(): boolean {
    return this.peerConnection?.connectionState === 'connected';
  }

  // 当前连接状态
  get connectionState(): RTCPeerConnectionState | null {
    return this.peerConnection?.connectionState || null;
  }

  // 本地媒体流
  get localMediaStream(): MediaStream | null {
    return this.localStream;
  }

  // 远程媒体流
  get remoteMediaStream(): MediaStream | null {
    return this.remoteStream;
  }

  /**
   * 获取完整状态信息
   * 返回包含所有关键状态的对象，可用于：
   * @returns {object|null} 状态对象或null(未初始化时)
   */
  getDetailedState() {
    if (!this.peerConnection) return null;
    
    return {
      signalingState: this.peerConnection.signalingState,       // 信令状态
      iceConnectionState: this.peerConnection.iceConnectionState, // ICE连接状态
      connectionState: this.peerConnection.connectionState,    // 整体连接状态
      iceGatheringState: this.peerConnection.iceGatheringState, // ICE收集状态
      isNegotiating: this.isNegotiating,                        // 是否正在协商
      hasLocalStream: !!this.localStream,                      // 是否有本地流
      hasRemoteStream: !!this.remoteStream,                     // 是否有远程流
    };
  }
  
}