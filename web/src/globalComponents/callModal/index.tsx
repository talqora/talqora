import React, { useEffect, useRef } from 'react';
import { Modal } from 'antd';
import { useCall } from '../../hooks/useCall';
import { useIsMobile } from '@/hooks/useIsMobile';
import VoiceCallPanel from './voiceCallPanel';
import VideoCallPanel from './videoCallPanel';
import styles from './style.module.scss';

// 通话弹窗容器:持有唯一的通话会话(useCall),并按 callType 切换到对应的展示面板。
// 媒体流绑定(远程音频 / 远视频 / 本地预览)集中在这里,面板只负责渲染。
export const CallModal: React.FC = () => {
  const { callState, acceptCall, rejectCall, terminateCall, toggleMute } = useCall();
  const isVideo = callState.callType === 'video';
  const isMobile = useIsMobile(); // antd Modal 宽度是内联 style,CSS 改不动,只能从 prop 走

  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // 远程音频:语音/视频通话都靠它出声(视频画面元素静音,避免双份音频)
  useEffect(() => {
    if (callState.remoteStream && remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = callState.remoteStream;
      remoteAudioRef.current.play().catch((err) => console.warn('远程音频自动播放被阻止', err));
    }
  }, [callState.remoteStream]);

  const handlers = {
    onAccept: acceptCall,
    onReject: rejectCall,
    onHangup: terminateCall,
    onToggleMute: toggleMute,
  };

  return (
    <>
      <Modal
        open={callState.isActive}
        footer={null}
        closable={false}
        centered
        width={isMobile ? '100vw' : isVideo ? 420 : 400}
        className={styles.callModal}
        maskClosable={false}
      >
        {isVideo ? (
          <VideoCallPanel callState={callState} {...handlers} />
        ) : (
          <VoiceCallPanel callState={callState} {...handlers} />
        )}
      </Modal>

      {/* 远程音频:隐藏播放(两种通话共用) */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
    </>
  );
};

export default CallModal;
