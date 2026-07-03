import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICECandidate } from '../globalType/call';

// coturn 短期凭据的真实拉取不在单测范围;给一条 TURN,让 buildRtcConfiguration 判定 hasTurn。
vi.mock('./iceServers', () => ({
  getIceServers: () => [{ urls: 'turn:example.com:3478?transport=tcp' }],
  ensureIceServers: vi.fn(),
}));

// 跨 PeerConnection 实例统计 addIceCandidate 调用(reset() 会换新 PC,断言要能看到新 PC 上的调用)。
const addIceCandidateSpy = vi.fn();

class MockPeerConnection {
  remoteDescription: unknown = null;
  localDescription: unknown = { type: 'answer', sdp: 'mock-answer' };
  signalingState = 'stable';
  connectionState = 'new';
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  oniceconnectionstatechange: unknown = null;
  onnegotiationneeded: unknown = null;
  async setRemoteDescription(desc: unknown) { this.remoteDescription = desc; }
  async setLocalDescription(desc: unknown) { this.localDescription = desc; }
  async createAnswer() { return { type: 'answer', sdp: 'mock-answer' }; }
  getSenders() { return []; }
  addTrack() { return {}; }
  async addIceCandidate(c: unknown) { addIceCandidateSpy(c); }
  close() { this.connectionState = 'closed'; }
}

class MockIceCandidate {
  candidate: string;
  sdpMLineIndex?: number;
  sdpMid?: string;
  constructor(init: { candidate: string; sdpMLineIndex?: number; sdpMid?: string }) {
    this.candidate = init.candidate;
    this.sdpMLineIndex = init.sdpMLineIndex;
    this.sdpMid = init.sdpMid;
  }
}

vi.stubGlobal('RTCPeerConnection', MockPeerConnection);
vi.stubGlobal('RTCIceCandidate', MockIceCandidate);

// 静音 WebRTCManager 里大量 console.log,保持测试输出干净。
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { WebRTCManager } = await import('./webrtc');

describe('WebRTCManager.reset() ICE 候选保留', () => {
  beforeEach(() => {
    addIceCandidateSpy.mockClear();
  });

  it('保留 accept 前暂存的对端候选,reset() 重建后经 handleOffer 应用', async () => {
    const manager = new WebRTCManager();

    // 被叫仍在振铃:主叫 trickle 来的候选此刻无 remoteDescription,被暂存。
    const early: ICECandidate[] = [
      { candidate: 'candidate:1 1 udp 2130706431 1.2.3.4 50000 typ host', sdpMlineIndex: 0, sdpMid: '0' },
      { candidate: 'candidate:2 1 udp 1694498815 5.6.7.8 50001 typ srflx', sdpMlineIndex: 0, sdpMid: '0' },
    ];
    for (const c of early) await manager.addIceCandidate(c);

    // 接受来电:reset() 重建 PC。修复前 cleanup() 会清空暂存候选 → 被叫永远拿不到主叫地址 → 媒体单向。
    manager.reset();

    // 处理 offer:setRemoteDescription 后应把暂存候选补进新 PC。
    await manager.handleOffer({ type: 'offer', sdp: 'mock-offer' });

    expect(addIceCandidateSpy).toHaveBeenCalledTimes(early.length);
    const applied = addIceCandidateSpy.mock.calls.map((call) => call[0].candidate);
    expect(applied).toEqual(early.map((c) => c.candidate));
  });
});
