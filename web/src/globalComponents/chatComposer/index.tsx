import { useState } from 'react';
import { useLang } from '@/i18n';
import styles from './style.module.scss';

// 输入区图标(表情 / 文件 / 语音 / 视频 等);不传则工具栏只留发送按钮
export interface ComposerAction {
  label: string;
  icon: string; // iconfont class, e.g. 'icon-meh'
  method: string;
}

interface ChatComposerProps {
  onSend: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  sending?: boolean;
  sendLabel?: string;
  leftActions?: ComposerAction[];
  rightActions?: ComposerAction[];
  onActionClick?: (method: string) => void;
  showSend?: boolean; // 是否显示发送按钮(微信桌面端始终显示,空内容时置灰)
  inputRows?: number;
}

// 全局通用聊天输入框。草稿态自管理(每次按键只重渲染本小块,不波及上层消息列表),
// Enter 发送、Shift+Enter 换行。好友聊天 / agent 知识对话 / agent 任务共用同一套。
// 结构对齐微信桌面端:一个描边圆角盒子,文本区在上、工具栏在盒内底部,发送按钮在右下。
function ChatComposer({
  onSend,
  placeholder,
  disabled = false,
  sending = false,
  sendLabel,
  leftActions,
  rightActions,
  onActionClick,
  showSend = true,
  inputRows = 2,
}: ChatComposerProps) {
  const { t } = useLang();
  const [input, setInput] = useState('');
  // 空内容不可发送:微信的发送按钮保持可见但置灰,不做显隐跳变
  const canSend = !disabled && !sending && input.trim().length > 0;

  const send = () => {
    const text = input.trim();
    if (!text || disabled || sending) return;
    onSend(text);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className={styles.composer}>
      <div className={styles.box}>
        <textarea
          className={styles.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={inputRows}
          placeholder={placeholder}
          disabled={disabled}
        />
        <div className={styles.toolbar}>
          <div className={styles.actions}>
            {leftActions?.map((it) => (
              <i
                key={it.label}
                title={it.label}
                className={`iconfont ${it.icon} ${styles.icon}`}
                onClick={() => onActionClick?.(it.method)}
              />
            ))}
          </div>
          <div className={styles.actions}>
            {rightActions?.map((it) => (
              <i
                key={it.label}
                title={it.label}
                className={`iconfont ${it.icon} ${styles.icon}`}
                onClick={() => onActionClick?.(it.method)}
              />
            ))}
            {showSend && (
              <button
                type="button"
                className={styles.send}
                disabled={!canSend}
                onClick={send}
              >
                {sendLabel ?? t('chat.send')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChatComposer;
