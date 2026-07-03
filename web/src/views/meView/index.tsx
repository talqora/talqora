import { useState } from 'react';
import { useSelector } from 'react-redux';
import meStyle from './style.module.scss';
import type { RootState } from '@/store/rootStore';
import { buildServerUrl } from '@/utils/runtime';
import { defaultAvatar } from '@/assets/images';
import { useLang } from '@/i18n';
import { useLogout } from '@/hooks/useLogout';
import SettingView from '@/views/settingView';

// 移动端「我」个人中心页:把桌面侧栏的头像资料 + ☰ 菜单(设置/退出)合并到一页。
// 仅经移动端底部「我」Tab 进入(桌面侧栏自有头像/菜单,不展示此 Tab)。
function MeView() {
    const { t } = useLang();
    const user = useSelector((state: RootState) => state.user);
    const logout = useLogout();
    const [settingVisible, setSettingVisible] = useState(false);

    return (
        <div className={meStyle.me}>
            {/* 头部:头像 + 昵称 + 微信号(ID) */}
            <div className={meStyle.header}>
                <img
                    className={meStyle.avatar}
                    src={user.avatar ? buildServerUrl(user.avatar) : defaultAvatar}
                    alt=""
                />
                <div className={meStyle.info}>
                    <div className={meStyle.name}>{user.nickname || user.username}</div>
                    <div className={meStyle.wxid}>{t('profile.wxid')}：{user.id}</div>
                </div>
            </div>

            {/* 设置 */}
            <div className={meStyle.group}>
                <div className={meStyle.row} onClick={() => setSettingVisible(true)}>
                    <i className={`iconfont icon-setting ${meStyle.rowIcon}`} />
                    <span className={meStyle.rowLabel}>{t('layout.menu.setting')}</span>
                    <i className={`iconfont icon-arrowright ${meStyle.chevron}`} />
                </div>
            </div>

            {/* 退出登录 */}
            <div className={meStyle.group}>
                <div className={`${meStyle.row} ${meStyle.danger}`} onClick={logout}>
                    <span className={meStyle.rowLabel}>{t('layout.menu.logout')}</span>
                </div>
            </div>

            {settingVisible && <SettingView onClose={() => setSettingVisible(false)} />}
        </div>
    );
}

export default MeView;
