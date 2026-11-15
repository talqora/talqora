import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './style.module.scss';

// 定高虚拟列表:只渲染视口内(+overscan)的行,总高度用占位撑开。
// 联系人数无上限,一次性渲染全量 DOM 会让滚动和内存都崩,这里必须做窗口化。
interface VirtualListProps<T> {
    items: T[];
    itemHeight: number;
    overscan?: number;       // 视口外额外渲染的行数,避免快速滚动露白
    className?: string;
    renderItem: (item: T, index: number) => ReactNode;
    onReachEnd?: () => void; // 滚动到接近底部时触发(用于懒加载下一页)
    footer?: ReactNode;
}

function VirtualList<T>({
    items,
    itemHeight,
    overscan = 6,
    className,
    renderItem,
    onReachEnd,
    footer,
}: VirtualListProps<T>) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [start, setStart] = useState(0);
    const [end, setEnd] = useState(Math.min(items.length, 20));
    // 回调放 ref:避免 onReachEnd 每次渲染换引用导致 recompute 反复重建
    const reachEndRef = useRef(onReachEnd);
    reachEndRef.current = onReachEnd;

    const recompute = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const total = items.length * itemHeight;
        const s = Math.max(0, Math.floor(el.scrollTop / itemHeight) - overscan);
        const visible = Math.ceil(el.clientHeight / itemHeight) + overscan * 2;
        setStart(s);
        setEnd(Math.min(items.length, s + visible));
        // 距底部不足 3 行时预取下一页
        if (el.scrollTop + el.clientHeight >= total - itemHeight * 3) {
            reachEndRef.current?.();
        }
    }, [items.length, itemHeight, overscan]);

    useEffect(() => {
        recompute();
        const el = scrollRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => recompute());
        ro.observe(el);
        return () => ro.disconnect();
    }, [recompute]);

    return (
        <div ref={scrollRef} className={`${styles.scroll} ${className ?? ''}`} onScroll={recompute}>
            <div className={styles.spacer} style={{ height: items.length * itemHeight }}>
                <div style={{ transform: `translateY(${start * itemHeight}px)` }}>
                    {items.slice(start, end).map((item, i) => renderItem(item, start + i))}
                </div>
            </div>
            {footer}
        </div>
    );
}

export default VirtualList;
