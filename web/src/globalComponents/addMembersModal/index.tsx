import { useEffect, useMemo, useRef, useState } from 'react';
import { addGroupMembers } from '@/globalApi/groupApi';
import { getFriendListPage } from '@/globalApi/friendApi';
import VirtualList from '@/globalComponents/virtualList';
import { buildServerUrl } from '@/utils/runtime';
import { defaultAvatar } from '@/assets/images';
import { useLang } from '@/i18n';
import styles from './style.module.scss';

interface Props {
    open: boolean;
    groupId: number;
    userId: number;
    // 已在群里的成员,不进入候选
    excludeIds: number[];
    onClose: () => void;
    onAdded: () => void;
}

interface Candidate {
    id: number;
    name: string;
    avatar: string;
}

const PAGE_SIZE = 50;

// 添加群成员(对齐微信:左「联系人」列表 + 右「添加群成员」已选区 + 底部取消/添加)
// 好友可能上万:候选列表走**键集分页 + 虚拟滚动**,只渲染视口内的行。
function AddMembersModal({ open, groupId, userId, excludeIds, onClose, onAdded }: Props) {
    const { t } = useLang();
    const [checked, setChecked] = useState<number[]>([]);
    const [keyword, setKeyword] = useState('');
    const [saving, setSaving] = useState(false);
    // 关闭即清空选择,避免下次打开残留
    const close = () => {
        setChecked([]);
        setKeyword('');
        onClose();
    };

    const [items, setItems] = useState<Candidate[]>([]);
    const [hasMore, setHasMore] = useState(true);
    const [loading, setLoading] = useState(false);
    const cursorRef = useRef(0);
    const loadingRef = useRef(false);

    // Esc 关闭
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);

    const loadPage = () => {
        if (loadingRef.current || !hasMore) return;
        loadingRef.current = true;
        setLoading(true);
        getFriendListPage(userId, cursorRef.current, PAGE_SIZE)
            .then((res) => {
                const d = res.data;
                if (!d) return;
                const rows = Object.keys(d.friendId)
                    .map((k) => Number(k))
                    .sort((a, b) => a - b)
                    .map((id) => ({
                        id,
                        name: (d.friendId as Record<string, string | null>)[String(id)]
                            || d.friendInfo[id]?.username
                            || '',
                        avatar: d.friendInfo[id]?.avatar
                            ? buildServerUrl(d.friendInfo[id].avatar as string)
                            : defaultAvatar,
                    }))
                    .filter((c) => c.name);
                setItems((prev) => [...prev, ...rows]);
                cursorRef.current = d.nextAfter ?? cursorRef.current;
                setHasMore(Boolean(d.hasMore));
            })
            .catch((err: Error) => console.error('好友分页加载失败:', err.message))
            .finally(() => {
                loadingRef.current = false;
                setLoading(false);
            });
    };

    // 打开时拉第一页
    useEffect(() => {
        if (open && items.length === 0) loadPage();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);
    const visible = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        return items.filter((c) => !excludeSet.has(c.id) && (!kw || c.name.toLowerCase().includes(kw)));
    }, [items, excludeSet, keyword]);

    const selected = useMemo(
        () => checked.map((id) => items.find((c) => c.id === id)).filter(Boolean) as Candidate[],
        [checked, items],
    );

    if (!open) return null;

    const toggle = (id: number) =>
        setChecked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

    const submit = () => {
        if (checked.length === 0 || saving) return;
        setSaving(true);
        addGroupMembers({ userId, groupId, memberIds: checked })
            .then(() => {
                setChecked([]);
                setKeyword('');
                onAdded();
                onClose();
            })
            .catch((err: Error) => console.error('添加群成员失败:', err.message))
            .finally(() => setSaving(false));
    };

    return (
        <div className={styles.mask} onClick={close}>
            <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
                {/* 左:联系人(分页 + 虚拟列表) */}
                <div className={styles.left}>
                    <div className={styles.search}>
                        <i className="iconfont icon-search" />
                        <input
                            value={keyword}
                            onChange={(e) => setKeyword(e.target.value)}
                            placeholder={t('group.searchContacts')}
                        />
                        {keyword && (
                            <i className={`iconfont icon-close ${styles.clear}`} onClick={() => setKeyword('')} />
                        )}
                    </div>
                    <div className={styles.groupTitle}>{t('group.contacts')}</div>
                    <VirtualList
                        items={visible}
                        itemHeight={44}
                        className={styles.list}
                        onReachEnd={loadPage}
                        renderItem={(c) => (
                            <label key={c.id} className={styles.row}>
                                <input
                                    type="checkbox"
                                    checked={checked.includes(c.id)}
                                    onChange={() => toggle(c.id)}
                                />
                                <span className={styles.check} aria-hidden />
                                <img src={c.avatar} alt="" />
                                <span className={styles.name}>{c.name}</span>
                            </label>
                        )}
                        footer={
                            visible.length === 0
                                ? <div className={styles.empty}>{loading ? t('common.loading') : t('group.noCandidate')}</div>
                                : loading
                                    ? <div className={styles.empty}>{t('common.loading')}</div>
                                    : null
                        }
                    />
                </div>

                {/* 右:已选 + 操作 */}
                <div className={styles.right}>
                    <div className={styles.title}>{t('group.addMembersTitle')}</div>
                    <div className={styles.selected}>
                        {selected.map((m) => (
                            <div className={styles.chip} key={m.id} onClick={() => toggle(m.id)} title={m.name}>
                                <img src={m.avatar} alt="" />
                                <span>{m.name}</span>
                            </div>
                        ))}
                    </div>
                    <div className={styles.footer}>
                        <button className={styles.cancel} onClick={close}>{t('common.cancel')}</button>
                        <button
                            className={styles.submit}
                            disabled={checked.length === 0 || saving}
                            onClick={submit}
                        >
                            {t('group.add')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default AddMembersModal;
