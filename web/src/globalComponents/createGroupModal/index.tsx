import { useMemo, useState } from 'react';
import { createGroup } from '@/globalApi/groupApi';
import { useLang } from '@/i18n';
import styles from './style.module.scss';

export interface GroupCandidate {
    id: number;
    name: string;
    avatar: string;
}

interface Props {
    open: boolean;
    userId: number;
    friends: GroupCandidate[];
    onClose: () => void;
    onCreated: (conversationId: string) => void;
}

// 发起群聊:勾选好友 → 建群(微信「+」→ 发起群聊 的等价入口)
function CreateGroupModal({ open, userId, friends, onClose, onCreated }: Props) {
    const { t } = useLang();
    const [checked, setChecked] = useState<number[]>([]);
    const [name, setName] = useState('');
    const [keyword, setKeyword] = useState('');
    const [saving, setSaving] = useState(false);

    const list = useMemo(
        () => friends.filter((f) => f.name.toLowerCase().includes(keyword.trim().toLowerCase())),
        [friends, keyword],
    );

    if (!open) return null;

    const toggle = (id: number) => {
        setChecked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    };

    const submit = () => {
        if (checked.length === 0 || saving) return;
        setSaving(true);
        createGroup(userId, checked, name)
            .then((res) => {
                if (res.data?.conversationId) onCreated(res.data.conversationId);
                setChecked([]);
                setName('');
                onClose();
            })
            .catch((err: Error) => console.error('建群失败:', err.message))
            .finally(() => setSaving(false));
    };

    return (
        <div className={styles.mask} onClick={onClose}>
            <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
                <div className={styles.header}>
                    <span className={styles.title}>{t('group.createTitle')}</span>
                    <i className={`iconfont icon-close ${styles.close}`} onClick={onClose} />
                </div>
                <div className={styles.search}>
                    <i className="iconfont icon-search" />
                    <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={t('group.searchPlaceholder')} />
                </div>
                <div className={styles.list}>
                    {list.length === 0 && <div className={styles.empty}>{t('group.noCandidate')}</div>}
                    {list.map((f) => (
                        <label key={f.id} className={styles.row}>
                            <input type="checkbox" checked={checked.includes(f.id)} onChange={() => toggle(f.id)} />
                            <img src={f.avatar} alt="" />
                            <span>{f.name}</span>
                        </label>
                    ))}
                </div>
                <div className={styles.footer}>
                    <input
                        className={styles.nameInput}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('group.namePlaceholder')}
                        maxLength={30}
                    />
                    <span className={styles.count}>{checked.length}</span>
                    <button className={styles.submit} disabled={checked.length === 0 || saving} onClick={submit}>
                        {t('group.create')}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default CreateGroupModal;
