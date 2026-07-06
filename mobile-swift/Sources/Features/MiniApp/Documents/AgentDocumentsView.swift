import ComposableArchitecture
import Services
import DesignSystem
import SwiftUI
import UniformTypeIdentifiers

struct AgentDocumentsView: View {
    @Bindable var store: StoreOf<AgentDocumentsFeature>
    @State private var showFilePicker = false

    var body: some View {
        NavigationStack {
            ZStack {
                WeChatColor.background.ignoresSafeArea()
                content
            }
            .navigationTitle("知识库")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    uploadButton
                }
            }
            .fileImporter(
                isPresented: $showFilePicker,
                allowedContentTypes: [.pdf, .plainText, .data],
                allowsMultipleSelection: false
            ) { result in
                switch result {
                case let .success(urls):
                    if let url = urls.first {
                        store.send(.uploadPicked(url))
                    }
                case .failure:
                    break
                }
            }
            .task { store.send(.onAppear) } // 首次出现即拉文档列表(缺它则 phase 永停 .idle 一直转圈)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .idle, .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView {
                Label("还没有文档", systemImage: "doc.text")
                    .foregroundStyle(WeChatColor.textSecondary)
            } description: {
                Text("点上传添加你的第一个文档")
                    .font(WeChatFont.subheadline)
                    .foregroundStyle(WeChatColor.textTertiary)
            }
        case .failed:
            ContentUnavailableView {
                Label("加载失败", systemImage: "wifi.exclamationmark")
            } description: {
                Text(store.errorMessage ?? "请检查网络后重试")
                    .font(WeChatFont.subheadline)
                    .foregroundStyle(WeChatColor.textTertiary)
            } actions: {
                Button("重试") { store.send(.load) }
                    .buttonStyle(PressableButtonStyle())
                    .foregroundStyle(WeChatColor.brand)
            }
        case .loaded:
            documentList
        }
    }

    private var documentList: some View {
        List {
            ForEach(store.documents) { doc in
                DocumentRow(document: doc)
                    .listRowBackground(WeChatColor.elevated)
            }
            .onDelete { offsets in
                for index in offsets {
                    let doc = store.documents[index]
                    store.send(.deleteTapped(doc.id))
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    private var uploadButton: some View {
        Button {
            showFilePicker = true
        } label: {
            if store.isUploading {
                ProgressView()
                    .frame(minWidth: 44, minHeight: 44)
            } else {
                Image(systemName: "plus")
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(store.isUploading)
        .accessibilityLabel("上传文档")
    }
}

private struct DocumentRow: View {
    let document: AgentDocument

    var body: some View {
        HStack(spacing: WeChatSpacing.m) {
            Image(systemName: "doc.text.fill")
                .font(WeChatFont.body)
                .foregroundStyle(WeChatColor.brand)
                .frame(width: 36, height: 36)
                .background(WeChatColor.brand.opacity(0.1), in: RoundedRectangle(cornerRadius: WeChatRadius.s))

            VStack(alignment: .leading, spacing: WeChatSpacing.xs) {
                Text(document.filename)
                    .font(WeChatFont.subheadline)
                    .foregroundStyle(WeChatColor.textPrimary)
                    .lineLimit(1)

                HStack(spacing: WeChatSpacing.s) {
                    if let size = document.size {
                        Text(formatSize(size))
                            .font(WeChatFont.caption)
                            .foregroundStyle(WeChatColor.textTertiary)
                    }
                    if let chunks = document.chunkCount, document.status == "ready" {
                        Text("\(chunks) 块")
                            .font(WeChatFont.caption)
                            .foregroundStyle(WeChatColor.textTertiary)
                    }
                }
            }

            Spacer()

            StatusBadge(status: document.status, error: document.error)
        }
        .padding(.vertical, WeChatSpacing.xs)
        .frame(minHeight: 44)
    }

    private func formatSize(_ bytes: Int) -> String {
        let kb = Double(bytes) / 1024
        if kb < 1024 {
            return String(format: "%.1f KB", kb)
        }
        return String(format: "%.1f MB", kb / 1024)
    }
}

private struct StatusBadge: View {
    let status: String
    let error: String?

    @State private var showError = false

    var body: some View {
        Button {
            if status == "failed", error != nil {
                showError = true
            }
        } label: {
            Text(label)
                .font(WeChatFont.caption)
                .foregroundStyle(foregroundColor)
                .padding(.horizontal, WeChatSpacing.s)
                .padding(.vertical, WeChatSpacing.xs)
                .background(backgroundColor.opacity(0.15), in: Capsule())
                .frame(minWidth: 44, minHeight: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(status != "failed" || error == nil)
        .alert("处理失败", isPresented: $showError) {
            Button("确认", role: .cancel) {}
        } message: {
            Text(error ?? "未知错误")
        }
    }

    private var label: String {
        switch status {
        case "ready": return "就绪"
        case "failed": return "失败"
        default: return "解析中"
        }
    }

    private var foregroundColor: Color {
        switch status {
        case "ready": return .green
        case "failed": return .red
        default: return .orange
        }
    }

    private var backgroundColor: Color {
        switch status {
        case "ready": return .green
        case "failed": return .red
        default: return .orange
        }
    }
}

#Preview("已加载") {
    AgentDocumentsView(
        store: Store(
            initialState: AgentDocumentsFeature.State(
                documents: [
                    AgentDocument(id: 1, filename: "合同范本.pdf", size: 204800, chunkCount: 24, status: "ready", error: nil),
                    AgentDocument(id: 2, filename: "报销流程说明.txt", size: 8192, chunkCount: nil, status: "parsing", error: nil),
                    AgentDocument(id: 3, filename: "上市规则.pdf", size: 1048576, chunkCount: nil, status: "failed", error: "文件格式不支持"),
                ],
                phase: .loaded
            )
        ) {
            AgentDocumentsFeature()
        } withDependencies: {
            $0.agentAPI = .previewValue
        }
    )
}

#Preview("空态") {
    AgentDocumentsView(
        store: Store(
            initialState: AgentDocumentsFeature.State(phase: .empty)
        ) {
            AgentDocumentsFeature()
        } withDependencies: {
            $0.agentAPI = .previewValue
        }
    )
}

#Preview("失败") {
    AgentDocumentsView(
        store: Store(
            initialState: AgentDocumentsFeature.State(
                phase: .failed,
                errorMessage: "服务器响应异常 (500)"
            )
        ) {
            AgentDocumentsFeature()
        } withDependencies: {
            $0.agentAPI = .previewValue
        }
    )
}

#Preview("深色") {
    AgentDocumentsView(
        store: Store(
            initialState: AgentDocumentsFeature.State(
                documents: [
                    AgentDocument(id: 1, filename: "合同范本.pdf", size: 204800, chunkCount: 24, status: "ready", error: nil),
                ],
                phase: .loaded
            )
        ) {
            AgentDocumentsFeature()
        } withDependencies: {
            $0.agentAPI = .previewValue
        }
    )
    .preferredColorScheme(.dark)
}
