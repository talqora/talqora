import { useSelector } from 'react-redux';
import layoutStyle from './style.module.scss';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useState, useRef, useEffect } from 'react';
import SettingView from '@/views/settingView';
import type { RootState } from '@/store/rootStore';
import useGlobalMessageListener from '@/hooks/useGlobalMessageListener';
import { useLogout } from '@/hooks/useLogout';
import CallModal from '@/globalComponents/callModal';
import { buildServerUrl } from '@/utils/runtime';
import { defaultAvatar } from '@/assets/images';
import { useLang } from '@/i18n';
import ProfileCard from '@/globalComponents/profileCard';
import PopoverMenu from '@/globalComponents/popoverMenu';

function Layout() {
    const user = useSelector((state: RootState) => state.user);
    const { t } = useLang();
    const handleLogout = useLogout();
    const { pathname } = useLocation();
    // 进入具体会话(/chat/:id)时,移动端隐藏底部 Tab 栏,聊天页全屏(微信交互)
    const inChatDetail = /^\/chat\/.+/.test(pathname);
    useGlobalMessageListener(); // 全局消息监听
    // 导航栏选项列表(桌面竖栏 / 移动底栏共用)
    const itemList = [
        {
            name: 'chat',
            icon: 'icon-message-fill',
            path: '/chat'
        },
        {
            name: 'directory',
            icon: 'icon-contacts-fill',
            path: '/directory'
        },
        {
            name: 'agent',
            icon: 'icon-robot-fill',
            path: '/agent'
        },
        {
            // 「我」仅移动端底栏显示;桌面侧栏用头像/☰ 提供同等功能
            name: 'me',
            icon: 'icon-user',
            path: '/me',
            mobileOnly: true,
        }
    ]

    // 菜单栏
    const [menuVisible, setMenuVisible] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    // 设置中心
    const [settingVisible, setSettingVisible] = useState(false);
    // 个人信息浮层(点头像弹出)
    const [profileVisible, setProfileVisible] = useState(false);
    const profileRef = useRef<HTMLDivElement>(null);
    // 点击外部关闭
    useEffect(() => {
        if (!menuVisible) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuVisible(false);
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [menuVisible]);

    // 点击外部关闭个人信息浮层
    useEffect(() => {
        if (!profileVisible) return;
        const handleClickOutside = (event: MouseEvent) => {
            if (profileRef.current && !profileRef.current.contains(event.target as Node)) setProfileVisible(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [profileVisible]);

    // 关闭设置中心(给子组件)
    const handleCloseSetting = () => {
        setSettingVisible(false);
    }
    // 点击设置中心
    const handleSetting = () => {
        setSettingVisible(!settingVisible);
    };    
    // 点击菜单栏
    const handleMenu = () => {
        setMenuVisible(!menuVisible);
    };
    // 点击头像 → 弹出个人信息浮层
    const handleProfile = () => {
        setProfileVisible(!profileVisible);
    };
    // 菜单选项
    const menuItems = [
        {
            key: 'setting',
            label: t('layout.menu.setting'),
            onClick: handleSetting,
        },
        {
            key: 'logout',
            label: t('layout.menu.logout'),
            onClick: handleLogout,
        },
    ];


    return (
        <div className={`${layoutStyle.layout_container} ${inChatDetail ? layoutStyle.no_tabbar : ''}`}>
            {/* 左导航栏 */}
            <div className={layoutStyle.left_nav}>
                {/* 头像 */}
                <div className={layoutStyle.left_nav_item_avatar} onClick={handleProfile}>
                        <img src={user.avatar ? buildServerUrl(user.avatar) : defaultAvatar} alt="" />
                </div>
                {/* 个人信息浮层:自己的资料卡(只读;设置/退出走左下角菜单) */}
                {profileVisible && (
                    <div className={layoutStyle.profile_anchor} ref={profileRef}>
                        <ProfileCard
                            avatar={user.avatar ? buildServerUrl(user.avatar) : ''}
                            name={user.nickname || user.username}
                            rows={[
                                { label: t('profile.wxid'), value: String(user.id) },
                                ...(user.email ? [{ label: t('profile.email'), value: user.email }] : []),
                            ]}
                            actions={[]}
                        />
                    </div>
                )}
                {/* 选项 */}
                {
                    itemList.map(item => {
                        return (
                            <NavLink
                                key={item.name}
                                to={item.path}
                                className={({isActive}) =>
                                    `${layoutStyle.left_nav_item} ${item.mobileOnly ? layoutStyle.mobile_only : ''} ${isActive ? layoutStyle.active : ''}`
                                }
                            >
                                <i className={`iconfont ${layoutStyle.my_iconfont} ${item.icon}`}></i>
                                <span className={layoutStyle.tab_label}>{t(`layout.tab.${item.name}`)}</span>
                            </NavLink>
                        )
                    })
                }
                {/* 设置中心 */}
                <div className={layoutStyle.left_nav_item_menu} onClick={handleMenu}>
                    <i className={`iconfont ${layoutStyle.my_iconfont} icon-menu`}></i>
                </div>
                {/* 菜单栏 */}
                {menuVisible && (
                    <div className={layoutStyle.menu_anchor} ref={menuRef}>
                        <PopoverMenu items={menuItems} />
                    </div>
                )}
            </div>


            {/* 二级路由出口 */}
            <Outlet/>
            {/* 设置中心弹窗 */}
            {settingVisible && (
                <SettingView onClose={handleCloseSetting}/>
            )}
            
            {/* 语音通话弹窗 */}
            <CallModal />
        </div>
    )
}

export default Layout;