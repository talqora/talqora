import { useEffect, useState } from 'react';
import { getGroupInfo, renameGroup, setGroupNickname, type GroupInfo } from '@/globalApi/groupApi';
import AddMembersModal from '@/globalComponents/addMembersModal';
import { buildServerUrl } from '@/utils/runtime';
import { defaultAvatar } from '@/assets/images';
import { useLang } from '@/i18n';
import styles from './style.module.scss';

interface Props {
    groupId: number;
    userId: number;
    // 改名成功后通知父组件刷新头部与列表(Redux 里的会话标题是启动时快照,不会自动变)
    onRenamed?: (name: string) => void;
}

// 群信息面板(微信:头部「⋯」→ 右侧资料栏):成员九宫格 + 群名 + 我在本群的昵称
function GroupInfoPanel({ groupId, userId, onRenamed }: Props) {
    const { t } = useLang();
    const [info, setInfo] = useState<GroupInfo | null>(null);
    const [keyword, setKeyword] = useState('');
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState('');
    const [addOpen, setAddOpen] = useState(false);
    const [nickEditing, setNickEditing] = useState(false);
    const [nickname, setNickname] = useState('');

    const reload = () => {
        getGroupInfo(groupId)
            .then((res) => setInfo(res.data ?? null))
            .catch(() => setInfo(null));
    };

    useEffect(() => {
        getGroupInfo(groupId)
            .then((res) => {
                setInfo(res.data ?? null);
                setName(res.data?.name ?? '');
            })
            .catch(() => setInfo(null));
    }, [groupId]);

    const isOwner = info?.ownerId === userId;
    const myNickname = info?.members.find((m) => m.userId === userId)?.nickname ?? '';
    const members = (info?.members ?? []).filter((m) =>
        m.username.toLowerCase().includes(keyword.trim().toLowerCase()),
    );

    const saveName = () => {
        if (!info || !name.trim()) return;
        renameGroup({ userId, groupId, name: name.trim() })
            .then(() => {
                setInfo({ ...info, name: name.trim() });
                onRenamed?.(name.trim());
            })
            .catch((err: Error) => console.error('改群名失败:', err.message))
            .finally(() => setEditing(false));
    };

    const saveNickname = () => {
        setGroupNickname({ userId, groupId, nickname })
            .then(() => {
                setInfo((prev) =>
                    prev
                        ? {
                            ...prev,
                            members: prev.members.map((m) =>
                                m.userId === userId ? { ...m, nickname: nickname.trim() || null } : m,
                            ),
                        }
                        : prev,
                );
            })
            .catch((err: Error) => console.error('设置本群昵称失败:', err.message))
            .finally(() => setNickEditing(false));
    };

    return (
        <aside className={styles.panel}>
            <div className={styles.search}>
                <i className="iconfont icon-search" />
                <input
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder={t('group.searchMembers')}
                />
            </div>

            <div className={styles.grid}>
                {members.map((m) => (
                    <div className={styles.cell} key={m.userId} title={m.username}>
                        <img src={m.avatar ? buildServerUrl(m.avatar) : defaultAvatar} alt="" />
                        <span>{m.nickname || m.username}</span>
                    </div>
                ))}
                {/* 微信在群主/管理员视角下还有「添加」「移出」格子;这里保留「添加」占位 */}
                {isOwner && (
                    <div className={`${styles.cell} ${styles.add}`} onClick={() => setAddOpen(true)}>
                        <span className={styles.addBox}>+</span>
                        <span>{t('group.addMember')}</span>
                    </div>
                )}
            </div>

            <div className={styles.section}>
                <div className={styles.label}>{t('group.nameLabel')}</div>
                {editing ? (
                    <div
                        className={styles.editRow}
                        onBlur={(e) => {
                            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEditing(false);
                        }}
                    >
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
                            maxLength={30}
                            autoFocus
                        />
                        <button onClick={saveName}>{t('common.save')}</button>
                    </div>
                ) : (
                    <div
                        className={`${styles.value} ${isOwner ? styles.editable : ''}`}
                        onClick={() => isOwner && setEditing(true)}
                    >
                        {info?.name ?? '—'}
                    </div>
                )}
            </div>

            <div className={styles.section}>
                <div className={styles.label}>{t('group.myNickname')}</div>
                {nickEditing ? (
                    <div
                        className={styles.editRow}
                        onBlur={(e) => {
                            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setNickEditing(false);
                        }}
                    >
                        <input
                            value={nickname}
                            onChange={(e) => setNickname(e.target.value)}
                            maxLength={32}
                            autoFocus
                            placeholder={t('group.myNicknameHint')}
                            onKeyDown={(e) => { if (e.key === 'Escape') setNickEditing(false); }}
                        />
                        <button onClick={saveNickname}>{t('common.save')}</button>
                    </div>
                ) : (
                    <div
                        className={`${styles.value} ${styles.editable}`}
                        onClick={() => {
                            setNickname(myNickname ?? '');
                            setNickEditing(true);
                        }}
                    >
                        {myNickname || t('group.myNicknameHint')}
                    </div>
                )}
            </div>

            <AddMembersModal
                open={addOpen}
                groupId={groupId}
                userId={userId}
                excludeIds={(info?.members ?? []).map((m) => m.userId)}
                onClose={() => setAddOpen(false)}
                onAdded={reload}
            />
        </aside>
    );
}

export default GroupInfoPanel;
