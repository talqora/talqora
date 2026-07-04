import ComposableArchitecture
import SwiftUI

// 备注编辑页:一个备注输入框 + 保存。经好友设置页「设置朋友资料」推入。
struct RemarkEditView: View {
    @Bindable var store: StoreOf<RemarkEditFeature>
    @FocusState private var remarkFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("备注名")
                    .font(.system(size: 13))
                    .foregroundStyle(WeChatColor.textSecondary)
                    .padding(.leading, 4)
                TextField("添加备注名", text: $store.remarkDraft)
                    .font(.system(size: 16))
                    .foregroundStyle(WeChatColor.textPrimary)
                    .tint(WeChatColor.brand)
                    .focused($remarkFocused)
                    .submitLabel(.done)
                    .onSubmit { store.send(.saveTapped) }
                    .padding(16)
                    .background(WeChatColor.elevated)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .padding(.horizontal, 12)
            .padding(.top, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(WeChatColor.background)
        .dismissKeyboardOnTap()
        .navigationTitle("设置备注")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // 二级页不保留底部 tab
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") { store.send(.saveTapped) }
                    .foregroundStyle(WeChatColor.brand)
                    .fontWeight(.medium)
                    .disabled(store.isSaving)
            }
        }
        .alert($store.scope(state: \.alert, action: \.alert))
        .onAppear { remarkFocused = true }
    }
}

#Preview {
    NavigationStack {
        RemarkEditView(
            store: Store(
                initialState: RemarkEditFeature.State(
                    contact: Contact(id: "1024", name: "老段", username: "段宇皓", remark: "老段", sectionKey: "D")
                )
            ) {
                RemarkEditFeature()
            }
        )
    }
    .preferredColorScheme(.dark)
}
