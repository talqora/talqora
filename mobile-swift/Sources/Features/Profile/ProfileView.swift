import ComposableArchitecture
import PhotosUI
import SwiftUI

// 个人资料页(图12)。头像/名字真实可改;性别/地区/手机号/微信号/二维码/签名等占位。
struct ProfileView: View {
    @Bindable var store: StoreOf<ProfileFeature>
    @Environment(ToastCenter.self) private var toast
    @State private var photoItem: PhotosPickerItem?
    @State private var cropTarget: CropTarget?
    @State private var nameEditing = false
    @State private var nameDraft = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Card {
                    avatarRow
                    Divider()
                    Row(title: "名字", value: store.profile.name) { beginNameEdit() }
                    Divider()
                    Row(title: "性别", value: "未知") { toast.show() }
                    Divider()
                    Row(title: "地区", value: "未设置") { toast.show() }
                }
                Card {
                    Row(title: "手机号", value: maskedPhonePlaceholder) { toast.show() }
                    Divider()
                    Row(title: "微信号", value: store.profile.wxid) { toast.show() }
                    Divider()
                    Row(title: "我的二维码", icon: "qrcode") { toast.show() }
                    Divider()
                    Row(title: "拍一拍", value: "未设置") { toast.show() }
                }
                Card { Row(title: "签名", value: "未填写") { toast.show() } }
                Card { Row(title: "来电铃声") { toast.show() } }
                Card { Row(title: "我的地址") { toast.show() } }
                Card { Row(title: "我的发票抬头") { toast.show() } }
                Card { Row(title: "微信豆") { toast.show() } }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 16)
        }
        .background(WeChatColor.background)
        .navigationTitle("个人资料")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // 二级页不保留底部 tab
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let image = UIImage(data: data) {
                    cropTarget = CropTarget(image: image)
                }
                photoItem = nil
            }
        }
        .fullScreenCover(item: $cropTarget) { target in
            AvatarCropView(
                image: target.image,
                onDone: { data in store.send(.avatarPicked(data)); cropTarget = nil },
                onCancel: { cropTarget = nil }
            )
        }
        .alert("修改名字", isPresented: $nameEditing) {
            TextField("名字", text: $nameDraft)
            Button("取消", role: .cancel) {}
            Button("保存") { store.send(.nameSaved(nameDraft)) }
        }
        .alert($store.scope(state: \.alert, action: \.alert))
    }

    private func beginNameEdit() {
        nameDraft = store.profile.name
        nameEditing = true
    }

    // 手机号服务端未透出,占位展示。
    private var maskedPhonePlaceholder: String { "未绑定" }

    private var avatarRow: some View {
        PhotosPicker(selection: $photoItem, matching: .images) {
            HStack(spacing: 8) {
                Text("头像")
                    .font(.system(size: 16))
                    .foregroundStyle(WeChatColor.textPrimary)
                Spacer(minLength: 8)
                Avatar(url: store.profile.avatarURL, size: 44, cornerRadius: 6)
                    .overlay {
                        if store.isUploadingAvatar {
                            ZStack {
                                Color.black.opacity(0.4)
                                ProgressView().tint(.white)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }
                    }
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WeChatColor.textTertiary)
            }
            .padding(.horizontal, 16)
            .frame(height: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("更换头像")
    }
}

// fullScreenCover(item:) 载体:携带待裁剪的 UIImage。
private struct CropTarget: Identifiable {
    let id = UUID()
    let image: UIImage
}

private struct Card<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(spacing: 0) { content }
            .background(WeChatColor.elevated)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

private struct Divider: View {
    var body: some View {
        Rectangle().fill(WeChatColor.separator).frame(height: 0.5).padding(.leading, 16)
    }
}

// 资料行:标题 +(可选值/图标)+ chevron;整行命中可点。
private struct Row: View {
    let title: LocalizedStringKey
    var value: String?
    var icon: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 16))
                    .foregroundStyle(WeChatColor.textPrimary)
                Spacer(minLength: 8)
                if let value {
                    Text(value)
                        .font(.system(size: 15))
                        .foregroundStyle(WeChatColor.textSecondary)
                        .lineLimit(1)
                }
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 18))
                        .foregroundStyle(WeChatColor.textSecondary)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WeChatColor.textTertiary)
            }
            .padding(.horizontal, 16)
            .frame(height: 53)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
    }
}

#Preview {
    NavigationStack {
        ProfileView(
            store: Store(initialState: ProfileFeature.State(profile: .sample)) {
                ProfileFeature()
            }
        )
    }
    .environment(ToastCenter())
    .preferredColorScheme(.dark)
}
