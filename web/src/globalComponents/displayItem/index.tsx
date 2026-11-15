// 导入样式模块，使用CSS Modules实现局部作用域样式
import { memo } from 'react';
import styles from './style.module.scss';

/**
 * DisplayItem组件的属性接口
 * @property {string} id - 唯一标识符
 * @property {string} avatar - 头像图片的URL
 * @property {string} title - 标题文本
 * @property {string} content - 内容文本
 * @property {boolean} [isActive] - 可选，表示是否处于激活状态
 * @property {(id: string) => void} [handleClick] - 可选，点击事件的回调函数
 * @property {object} [style] - 可选，自定义样式对象
 * @property {string} style.width - 宽度
 * @property {string} style.height - 高度
 * @property {string} [style.backgroundColor] - 背景色
 */
interface DisplayItemProps {
    id: string;
    avatar: string;
    title: string;
    content: string;
    time?: string; // 右上角时间(会话列表用;通讯录不传)
    isActive?: boolean;
    // 紧凑行:通讯录用(微信通讯录行高 ~44,比会话行 64 更密)
    compact?: boolean;
    handleClick?: (id: string) => void;
    style?: {
        width: string;
        height: string;
        backgroundColor?: string;
    };
}

/**
 * DisplayItem组件
 * 一个可复用的显示项组件，包含头像、标题和内容
 * @param {DisplayItemProps} props - 组件属性
 * @returns {JSX.Element} - 渲染的React元素
 */
function DisplayItem({ id, avatar, title, content, time, isActive, handleClick = () => {}, style, compact }: DisplayItemProps) {
    return (
        // 外层容器，根据isActive状态添加active类名
        <div
            className={`${styles.display_item} ${compact ? styles.compact : ''} ${isActive ? styles.active : ''}`}
            onClick={() => { handleClick(id); }}
            style={{backgroundColor: style?.backgroundColor}}
        >
            {/* 头像区域，可自定义宽高 */}
            <div className={styles.item_avatar} style={{width: style?.width, height: style?.height}}>
                <img src={avatar} alt="" />
            </div>
            {/* 内容区域 */}
            <div className={styles.item_content_container}>
                <div className={styles.item_row}>
                    <div className={styles.item_title}>{title}</div>
                    {time && <div className={styles.item_time}>{time}</div>}
                </div>
                {/* 内容文本，仅在content存在时渲染 */}
                {content && <div className={styles.item_content}>{content}</div>}
            </div>
        </div>
    )
}

// memo：props 全是基本类型（字符串/布尔），浅比较按值即可命中。
// 这样会话列表在父组件因「新消息到达」重渲染时，只有 content 真正变化的那一行会重渲染，
// 其余行被跳过。生效前提是父组件传入的 handleClick 引用稳定（ChatView 已用 useCallback 固定）。
export default memo(DisplayItem);