import SwiftUI
import UIKit

// 自研头像裁剪(纯 SwiftUI,不引第三方):方形取景框内拖动 + 双指缩放,
// 「完成」用 ImageRenderer 把当前取景内容渲染成正方形 JPEG 回传。
struct AvatarCropView: View {
    let image: UIImage
    let onDone: (Data) -> Void
    let onCancel: () -> Void

    @Environment(\.displayScale) private var displayScale

    @State private var scale: CGFloat = 1
    @GestureState private var gestureScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var gestureOffset: CGSize = .zero

    private let side: CGFloat = 300 // 取景框边长(pt),渲染时按 displayScale 提清晰度

    private var currentScale: CGFloat { max(1, scale * gestureScale) }
    private var currentOffset: CGSize {
        CGSize(width: offset.width + gestureOffset.width, height: offset.height + gestureOffset.height)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            cropContent
                .overlay(Rectangle().stroke(.white.opacity(0.7), lineWidth: 1))
                .gesture(
                    SimultaneousGesture(
                        MagnifyGesture()
                            .updating($gestureScale) { value, state, _ in state = value.magnification }
                            .onEnded { scale = max(1, scale * $0.magnification) },
                        DragGesture()
                            .updating($gestureOffset) { value, state, _ in state = value.translation }
                            .onEnded {
                                offset.width += $0.translation.width
                                offset.height += $0.translation.height
                            }
                    )
                )

            VStack {
                HStack {
                    Button("取消", action: onCancel)
                        .foregroundStyle(.white)
                    Spacer()
                    Button("完成", action: renderAndDone)
                        .foregroundStyle(WeChatColor.brand)
                        .fontWeight(.semibold)
                }
                .font(.system(size: 17))
                .padding(.horizontal, 20)
                .padding(.vertical, 14)

                Spacer()

                Text("拖动 · 双指缩放")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.7))
                    .padding(.bottom, 40)
            }
        }
    }

    // 取景内容:显示与渲染共用同一段视图,保证「所见即所得」。
    private var cropContent: some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: side, height: side)
            .scaleEffect(currentScale)
            .offset(currentOffset)
            .frame(width: side, height: side)
            .clipped()
    }

    @MainActor private func renderAndDone() {
        let renderer = ImageRenderer(content: cropContent)
        renderer.scale = displayScale
        guard let rendered = renderer.uiImage,
              let data = rendered.jpegData(compressionQuality: 0.85) else {
            onCancel() // 渲染失败也退出,不把用户卡在裁剪页
            return
        }
        onDone(data)
    }
}
