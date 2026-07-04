import ComposableArchitecture
import SwiftUI

struct ContactsView: View {
    @Bindable var store: StoreOf<ContactsFeature>
    @Environment(ToastCenter.self) private var toast

    private let specials: [SpecialEntry] = [
        SpecialEntry(title: "新的朋友", icon: "person.crop.circle.badge.plus", color: Color(hex: 0xFA9D3B)),
        SpecialEntry(title: "仅聊天的朋友", icon: "person.crop.circle", color: Color(hex: 0xFA9D3B)),
        SpecialEntry(title: "群聊", icon: "person.2.fill", color: WeChatColor.brand),
        SpecialEntry(title: "标签", icon: "tag.fill", color: Color(hex: 0x2782D7)),
        SpecialEntry(title: "公众号", icon: "book.fill", color: Color(hex: 0x2782D7)),
        SpecialEntry(title: "服务号", icon: "rhombus.fill", color: Color(hex: 0x2782D7)),
    ]

    private let indexTitles: [String] = ["↑", "☆"] + (UnicodeScalar("A").value ... UnicodeScalar("Z").value)
        .map { String(UnicodeScalar($0)!) } + ["#"]

    var body: some View {
        NavigationStack(path: $store.scope(state: \.path, action: \.path)) {
            ScrollViewReader { proxy in
                List {
                    Section {
                        ForEach(Array(specials.enumerated()), id: \.element.id) { index, entry in
                            Group {
                                if index == 0 {
                                    // 第一项「新的朋友」可点进收发请求页,收到请求显示红点。
                                    Button { store.send(.newFriendsTapped) } label: {
                                        SpecialRow(entry: entry, showDot: store.hasNewFriendRequest)
                                    }
                                    .buttonStyle(.plain)
                                } else {
                                    Button { toast.show() } label: {
                                        SpecialRow(entry: entry)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .id(index == 0 ? "__top__" : entry.id.uuidString)
                            .listRowInsets(rowInsets)
                            .listRowBackground(WeChatColor.background)
                            .listRowSeparatorTint(WeChatColor.separator)
                            .alignmentGuide(.listRowSeparatorLeading) { _ in 52 }
                        }
                    }

                    Section {
                        Button { toast.show() } label: {
                            SpecialRow(entry: SpecialEntry(
                                title: "企业微信联系人", icon: "bubble.left.fill", color: Color(hex: 0x2782D7)
                            ))
                        }
                        .buttonStyle(.plain)
                        .listRowInsets(rowInsets)
                        .listRowBackground(WeChatColor.background)
                        .listRowSeparatorTint(WeChatColor.separator)
                        .alignmentGuide(.listRowSeparatorLeading) { _ in 52 }
                    } header: {
                        SectionHeader(title: "我的企业及企业联系人")
                    }

                    // 联系人区三态:加载中 / 加载失败(内联重试);特殊入口始终保留。
                    if store.isLoading && store.contacts.isEmpty {
                        Section {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 24)
                                .listRowBackground(WeChatColor.background)
                                .listRowSeparator(.hidden)
                        }
                    } else if let error = store.loadError, store.contacts.isEmpty {
                        Section {
                            VStack(spacing: 10) {
                                Text(LocalizedStringKey(error))
                                    .font(.system(size: 14))
                                    .foregroundStyle(WeChatColor.textSecondary)
                                    .multilineTextAlignment(.center)
                                Button("重试") { store.send(.reloadTapped) }
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(WeChatColor.brand)
                                    .buttonStyle(PressableButtonStyle())
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                            .listRowBackground(WeChatColor.background)
                            .listRowSeparator(.hidden)
                        }
                    }

                    ForEach(store.contacts.groupedBySection(), id: \.key) { section in
                        Section {
                            ForEach(section.contacts) { contact in
                                Button { store.send(.contactTapped(contact)) } label: {
                                    ContactRow(contact: contact)
                                }
                                .buttonStyle(.plain)
                                .listRowInsets(rowInsets)
                                .listRowBackground(WeChatColor.background)
                                .listRowSeparatorTint(WeChatColor.separator)
                                .alignmentGuide(.listRowSeparatorLeading) { _ in 52 }
                            }
                        } header: {
                            SectionHeader(title: section.key).id(section.key)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(WeChatColor.background)
                .overlay(alignment: .trailing) {
                    IndexBar(titles: indexTitles) { title in
                        withAnimation {
                            proxy.scrollTo(scrollTarget(for: title), anchor: .top)
                        }
                    }
                }
            }
            .navigationTitle("通讯录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 22) {
                        Button { toast.show() } label: { Image(systemName: "magnifyingglass") }
                            .accessibilityLabel("搜索")
                        Button { toast.show() } label: { Image(systemName: "plus.circle") }
                            .accessibilityLabel("添加")
                    }
                    .font(.system(size: 18))
                    .foregroundStyle(WeChatColor.textPrimary)
                }
            }
            .task { store.send(.onAppear) }
        } destination: { store in
            switch store.case {
            case let .newFriends(store): NewFriendsView(store: store)
            case let .contactDetail(store): ContactDetailView(store: store)
            case let .friendSettings(store): FriendSettingsView(store: store)
            case let .remarkEdit(store): RemarkEditView(store: store)
            case let .chat(store): ChatDetailView(store: store)
            }
        }
    }

    private var rowInsets: EdgeInsets { EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16) }

    private func scrollTarget(for indexTitle: String) -> String {
        indexTitle == "↑" || indexTitle == "☆" ? "__top__" : indexTitle
    }
}

private struct SpecialEntry: Identifiable, Equatable {
    let id = UUID()
    let title: LocalizedStringKey // 随语言令牌本地化
    let icon: String
    let color: Color
}

private struct SpecialRow: View {
    let entry: SpecialEntry
    var showDot: Bool = false

    var body: some View {
        HStack(spacing: 12) {
            IconTile(systemName: entry.icon, color: entry.color, size: 40, cornerRadius: 6)
                .overlay(alignment: .topTrailing) {
                    if showDot {
                        Circle()
                            .fill(WeChatColor.badge)
                            .frame(width: 10, height: 10)
                            .overlay(Circle().stroke(WeChatColor.background, lineWidth: 1.5))
                            .offset(x: 3, y: -3)
                    }
                }
            Text(entry.title)
                .font(.system(size: 16))
                .foregroundStyle(WeChatColor.textPrimary)
            Spacer()
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}

private struct ContactRow: View {
    let contact: Contact

    var body: some View {
        HStack(spacing: 12) {
            Avatar(url: contact.avatarURL, size: 40)
            Text(contact.name)
                .font(.system(size: 16))
                .foregroundStyle(WeChatColor.textPrimary)
                .lineLimit(1)
            Spacer()
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}

private struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 13))
            .foregroundStyle(WeChatColor.textSecondary)
            .textCase(nil)
            .padding(.vertical, 2)
    }
}

private struct IndexBar: View {
    let titles: [String]
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 1) {
            ForEach(titles, id: \.self) { title in
                Text(title)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(WeChatColor.textSecondary)
                    .frame(width: 18, height: 13)
                    .contentShape(Rectangle())
                    .onTapGesture { onSelect(title) }
            }
        }
        .padding(.trailing, 2)
    }
}

#Preview {
    ContactsView(
        store: Store(initialState: ContactsFeature.State()) {
            ContactsFeature()
        }
    )
    .environment(ToastCenter())
    .preferredColorScheme(.dark)
}
