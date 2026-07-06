import SwiftUI

// 全 App 统一「占位提示」轻反馈:未上线的功能点点击后弹出短暂 toast(非阻断,呼应 CLAUDE.md §3)。
// 注入于 AppView 根,顶层 overlay 呈现;占位点直接 @Environment 取用后调 show(),无需各自 reducer 加 no-op action。
@MainActor
@Observable
public final class ToastCenter {
    public private(set) var message: String?
    private var dismissTask: Task<Void, Never>?

    public init() {}

    public func show(_ text: String = "该功能暂未上线") {
        message = text
        dismissTask?.cancel()
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.8))
            guard !Task.isCancelled else { return }
            self?.message = nil
        }
    }
}

// 顶层提示视图:深色胶囊,居中略偏下,淡入淡出;不拦截点击。
public struct ToastOverlay: View {
    @Environment(ToastCenter.self) private var toast

    public init() {}

    public var body: some View {
        ZStack {
            if let message = toast.message {
                Text(LocalizedStringKey(message))
                    .font(.system(size: 15))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                    .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .padding(.horizontal, 40)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeInOut(duration: 0.2), value: toast.message)
        .allowsHitTesting(false)
    }
}
