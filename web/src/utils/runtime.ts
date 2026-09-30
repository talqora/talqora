const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const normalizePath = (path: string) => path.startsWith('/') ? path : `/${path}`;

const currentHostname =
  typeof window !== 'undefined' ? window.location.hostname : 'localhost';

const currentProtocol =
  typeof window !== 'undefined' ? window.location.protocol : 'http:';

const serverPort = import.meta.env.VITE_SERVER_PORT || '3007';
const serverProtocol =
  import.meta.env.VITE_SERVER_PROTOCOL || (currentProtocol === 'https:' ? 'https:' : 'http:');

const envServerOrigin = import.meta.env.VITE_SERVER_ORIGIN?.trim();

function resolveServerOrigin(): string {
  // 优先相信外部显式配置。只要配置了完整 origin，就直接使用，不再做自动推导。
  if (envServerOrigin) {
    return trimTrailingSlash(envServerOrigin);
  }

  // 这里直接复用浏览器当前访问页面的 origin，例如：
  // - 页面从 `https://192.168.31.20:5173` 打开
  // - 这里就先得到 `https://192.168.31.20:5173`
  //
  // 让“当前正在访问这个前端的设备”始终以看到的地址去请求服务端，
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    return trimTrailingSlash(window.location.origin);
  }

  // 非开发场景下，如果没有提供完整 origin，就退化为：
  // “当前页面主机名 + 配置协议 + 配置端口”
  // 例如当前主机名是 `example.com`，协议配置为 `https:`，端口为 `3007`，
  // 最终会得到 `https://example.com:3007`。
  return `${serverProtocol}//${currentHostname}:${serverPort}`;
}

export const SERVER_ORIGIN = resolveServerOrigin();

export const API_BASE_URL = SERVER_ORIGIN;

export const buildServerUrl = (path: string) => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${SERVER_ORIGIN}${normalizePath(path)}`;
};
