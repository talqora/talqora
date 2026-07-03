import { useSyncExternalStore } from 'react';

// 移动端临界宽度。与 src/style/tokens.scss 的 $bp-md(768px)保持同步:
// 同一断点在 TS / SCSS 两种宿主里的副本,改动时两处一起改。
export const MOBILE_MAX = 768;
const QUERY = `(max-width: ${MOBILE_MAX}px)`;

// 仅供 CSS 够不到的场景使用(如 antd Modal 的内联 width);
// 纯表现差异请用 SCSS 的 @include mobile。
// useSyncExternalStore 保证并发渲染下读值与真实视口无撕裂;getServerSnapshot 默认桌面。
export function useIsMobile(): boolean {
    return useSyncExternalStore(
        (onChange) => {
            const mql = window.matchMedia(QUERY);
            mql.addEventListener('change', onChange);
            return () => mql.removeEventListener('change', onChange);
        },
        () => window.matchMedia(QUERY).matches,
        () => false,
    );
}
