import { useState } from 'react';
import { useLang } from '@/i18n';
import styles from './style.module.scss';

export interface PanelAction {
  label: string;
  icon: string; // iconfont class
  method: string;
}

interface MobileComposerProps {
  onSend: (text: string) => void;
  placeholder?: string;
  panelActions: PanelAction[];
  onActionClick: (method: string) => void;
}

// 移动端微信式聊天输入栏:语音切换 + 圆角输入 + 表情 + ＋面板/发送。
// 仅窄屏聊天页使用(桌面仍走 ChatComposer 工具条),不影响 agent 等其它场景。
function MobileComposer({ onSend, placeholder, panelActions, onActionClick }: MobileComposerProps) {
  const { t } = useLang();
  const [text, setText] = useState('');
  const [voiceMode, setVoiceMode] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  const hasText = text.trim().length > 0;

  const send = () => {
    if (!hasText) return;
    onSend(text);
    setText('');
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const clickAction = (method: string) => {
    setPanelOpen(false);
    onActionClick(method);
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        {/* 语音 / 文本 切换 */}
        <i
          className={`iconfont icon-sound ${styles.leftIcon} ${voiceMode ? styles.leftIconOn : ''}`}
          onClick={() => setVoiceMode((v) => !v)}
        />
        {/* 输入区 / 按住说话 */}
        {voiceMode ? (
          <button type="button" className={styles.holdBtn}>{t('chat.holdToTalk')}</button>
        ) : (
          <textarea
            className={styles.input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setPanelOpen(false)}
            rows={1}
            placeholder={placeholder}
          />
        )}
        {/* 无文字时显示语音输入麦克风 */}
        {!hasText && (
          <i
            className={`iconfont icon-audio ${styles.rightIcon}`}
            onClick={() => onActionClick('voiceInput')}
          />
        )}
        {/* 表情 */}
        <i className={`iconfont icon-meh ${styles.rightIcon}`} onClick={() => onActionClick('emoji')} />
        {/* 有文字 → 发送;否则 → ＋ 面板 */}
        {hasText ? (
          <button type="button" className={styles.sendBtn} onClick={send}>{t('chat.send')}</button>
        ) : (
          <button
            type="button"
            className={`${styles.plusBtn} ${panelOpen ? styles.plusBtnOpen : ''}`}
            aria-label="more"
            onClick={() => setPanelOpen((v) => !v)}
          />
        )}
      </div>

      {/* ＋ 面板:2×4 功能宫格 */}
      {panelOpen && (
        <div className={styles.panel}>
          {panelActions.map((a) => (
            <button type="button" key={a.method} className={styles.cell} onClick={() => clickAction(a.method)}>
              <span className={styles.cellIcon}>
                <i className={`iconfont ${a.icon}`} />
              </span>
              <span className={styles.cellLabel}>{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default MobileComposer;
