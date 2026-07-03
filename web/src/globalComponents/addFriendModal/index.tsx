import { forwardRef, useState } from 'react';
import styles from './style.module.scss';
import { addFriend } from '@/globalApi/friendApi';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '@/store/rootStore';
import { addFriendReq } from '@/store/friendStore';

interface AddFriendModalProps {
    avatar: string;
    username: string;
    wxid: string;
    region: string;
    gender: string;
}

const AddFriendModal = forwardRef<HTMLDivElement, AddFriendModalProps>(
  ({ avatar, username, wxid, region, gender }, ref) => {
    const dispatch = useDispatch();
    const userId = useSelector((state: RootState) => state.user.id);
    const [isSent, setIsSent] = useState(false);
    // 发起好友请求
    const handleAddFriend = async () => {
        addFriend({userId, friendId: Number(wxid)});
        // 好友请求的实时推送改由服务端在 addFriend 路由里驱动(见 server routes/friend.ts),前端不再 emit。
      dispatch(addFriendReq({
        id: 0,
        friendId: Number(wxid),
        userId: userId,
        status: 'sent',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        remark: '',
      }));
        setIsSent(true);
    }
    return (
      <div ref={ref} className={styles.container}>
        {/* 头部 */}
        <div className={styles.header}>
          {/* 头像 */}
          <img className={styles.avatar} src={avatar} alt="头像" />
          {/* 好友信息 */}
          <div className={styles.info}>
            <div className={styles.username}>
              {username}
              {gender === 'male'
                ? <i className={`iconfont icon-user ${styles.iconUser}`} />
                : <i className={`iconfont icon-user ${styles.iconUser}`} style={{ color: 'var(--warning-color)' }} />}
            </div>
            <div className={styles.wxid}> 微信号：{wxid} </div>
            <div className={styles.region}> 地区：{region} </div>
          </div>
        </div>
        {/* 底部 */}
        <div className={styles.footer}>
          <button className={styles.button} onClick={handleAddFriend}>{isSent ? '已发送' : '添加到通讯录'}</button>
        </div>
      </div>
    );
  }
);

export default AddFriendModal;