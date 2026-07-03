import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { logout } from '@/store/userStore';
import { post } from '@/utils/http';

// 退出登录:通知后端清 cookie(失败不阻塞)→ 清本地状态 → 跳登录页。
// 桌面 ☰ 菜单与移动「我」页共用,避免逻辑重复。
export function useLogout() {
    const dispatch = useDispatch();
    const navigate = useNavigate();
    return async () => {
        try {
            await post('/api/logout');
        } catch {
            // 网络异常忽略,本地仍照常清理并跳转
        }
        dispatch(logout());
        localStorage.removeItem('persist:root');
        navigate('/auth'); // layout 卸载会触发 useEffect 断开 socket
    };
}
