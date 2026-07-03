import styles from './style.module.scss';
import { useLang } from '@/i18n';

export interface ActionSheetItem {
  label: string;
  icon?: string; // iconfont class
  danger?: boolean;
  onClick: () => void;
}

interface ActionSheetProps {
  open: boolean;
  items: ActionSheetItem[];
  cancelLabel?: string;
  onClose: () => void;
}

// 微信式底部动作面板:遮罩 + 贴底选项组 + 取消。点选项/遮罩/取消都关闭。
function ActionSheet({ open, items, cancelLabel, onClose }: ActionSheetProps) {
  const { t } = useLang();
  if (!open) return null;
  return (
    <div className={styles.mask} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={styles.group}>
          {items.map((it) => (
            <button
              type="button"
              key={it.label}
              className={`${styles.item} ${it.danger ? styles.danger : ''}`}
              onClick={() => {
                it.onClick();
                onClose();
              }}
            >
              {it.icon && <i className={`iconfont ${it.icon} ${styles.icon}`} />}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className={styles.cancel} onClick={onClose}>
          {cancelLabel ?? t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

export default ActionSheet;
