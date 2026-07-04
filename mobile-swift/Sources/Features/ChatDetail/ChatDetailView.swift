import ComposableArchitecture
import Kingfisher
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChatDetailView: View {
    @Bindable var store: StoreOf<ChatDetailFeature>
    @State private var photoItem: PhotosPickerItem?
    @State private var fileImporterPresented = false
    @FocusState private var inputFocused: Bool

    var body: some View {
        // 消息区铺满 + 输入条贴底(safeAreaInset 让键盘弹出时输入条上移不遮挡);
        // 点消息空白处收键盘(§1 UIUX 硬规范)。
        messageList
            .safeAreaInset(edge: .bottom, spacing: 0) { inputBar }
            .background(WeChatColor.background)
            .dismissKeyboardOnTap()
            .navigationTitle(store.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar(.hidden, for: .tabBar) // 二级页不保留底部 tab
            .alert($store.scope(state: \.alert, action: \.alert))
            .task { store.send(.onAppear) }
    }

    // 首条或与上一条间隔 > 5 分钟时显示时间(对齐 web 的 5 分钟分组);无时间戳则不显示。
    private func timeSeparator(at index: Int) -> String? {
        guard let current = store.messages[index].timestamp else { return nil }
        guard index > 0, let previous = store.messages[index - 1].timestamp else {
            return Self.timeText(current)
        }
        return current.timeIntervalSince(previous) > 300 ? Self.timeText(current) : nil
    }

    private static func timeText(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(.dateTime.month().day().hour().minute())
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(Array(store.messages.enumerated()), id: \.element.id) { index, message in
                        VStack(spacing: 12) {
                            if let time = timeSeparator(at: index) {
                                Text(time)
                                    .font(.system(size: 12))
                                    .foregroundStyle(WeChatColor.textTertiary)
                                    .frame(maxWidth: .infinity)
                            }
                            MessageBubble(message: message, isMine: message.senderId == store.currentUserId)
                        }
                        .id(message.id)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.messages.count) {
                guard let last = store.messages.last else { return }
                withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 10) {
            PhotosPicker(selection: $photoItem, matching: .images) {
                Image(systemName: "photo.on.rectangle")
                    .font(.system(size: 22))
                    .foregroundStyle(WeChatColor.textSecondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("发送图片")
            .onChange(of: photoItem) { _, newItem in
                guard let newItem else { return }
                Task {
                    if let data = try? await newItem.loadTransferable(type: Data.self) {
                        store.send(.imageSelected(data))
                    }
                    photoItem = nil
                }
            }
            Button { fileImporterPresented = true } label: {
                Image(systemName: "doc")
                    .font(.system(size: 21))
                    .foregroundStyle(WeChatColor.textSecondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("发送文件")
            .fileImporter(isPresented: $fileImporterPresented, allowedContentTypes: [.item]) { result in
                guard case let .success(fileURL) = result else { return }
                let accessed = fileURL.startAccessingSecurityScopedResource()
                defer { if accessed { fileURL.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: fileURL) else { return }
                let mimeType = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                store.send(.fileSelected(data: data, filename: fileURL.lastPathComponent, mimeType: mimeType))
            }
            TextField("", text: $store.draft)
                .textFieldStyle(.plain)
                .focused($inputFocused)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(WeChatColor.elevated, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .foregroundStyle(WeChatColor.textPrimary)
                .submitLabel(.send)
                .onSubmit { store.send(.sendButtonTapped) }
            Button { store.send(.sendButtonTapped) } label: {
                Text("发送")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(WeChatColor.brand, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(WeChatColor.navBar)
    }
}

// 消息气泡:我方右对齐微信绿,对方左对齐深色卡片。
private struct MessageBubble: View {
    let message: ChatMessage
    let isMine: Bool

    var body: some View {
        HStack {
            if isMine { Spacer(minLength: 48) }
            bubble
            if !isMine { Spacer(minLength: 48) }
        }
    }

    @ViewBuilder private var bubble: some View {
        if message.type == "image", let url = URL(string: message.content) {
            KFImage(url)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: 180, maxHeight: 240)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else if message.type == "file", let info = message.fileInfo {
            FileCard(info: info)
        } else {
            Text(message.content)
                .font(.system(size: 16))
                .foregroundStyle(isMine ? Color(hex: 0x111111) : WeChatColor.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(
                    isMine ? WeChatColor.brand : WeChatColor.elevated,
                    in: RoundedRectangle(cornerRadius: 6, style: .continuous)
                )
        }
    }
}

// 文件卡片:图标 + 文件名 + 大小,微信风格白底卡。
private struct FileCard: View {
    let info: MessageFileInfo

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(info.fileName)
                    .font(.system(size: 15))
                    .foregroundStyle(WeChatColor.textPrimary)
                    .lineLimit(2)
                Text(byteSize(info.fileSize))
                    .font(.system(size: 12))
                    .foregroundStyle(WeChatColor.textSecondary)
            }
            .frame(maxWidth: 160, alignment: .leading)
            Image(systemName: "doc.fill")
                .font(.system(size: 32))
                .foregroundStyle(WeChatColor.brand)
        }
        .padding(12)
        .background(WeChatColor.elevated, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func byteSize(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

#Preview {
    NavigationStack {
        ChatDetailView(
            store: Store(
                initialState: ChatDetailFeature.State(conversationId: "single_1_2", title: "段宇皓", currentUserId: 1)
            ) {
                ChatDetailFeature()
            } withDependencies: {
                $0.chatClient.messages = { _ in MessageSamples.all }
                $0.socketClient = .previewValue
            }
        )
    }
    .preferredColorScheme(.dark)
}
