import SwiftUI
import DesignSystem

// 界面与显示页:外观(跟随系统/浅色/深色)+ 语言(跟随系统/中文/English)。写 @AppStorage,根视图即时应用。
struct AppearanceView: View {
    @AppStorage("appearanceMode") private var appearance: AppearanceMode = .system
    @AppStorage("appLanguage") private var language: LanguageMode = .system

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                pickerCard(title: "外观") {
                    Picker("外观", selection: $appearance) {
                        ForEach(AppearanceMode.allCases, id: \.self) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                pickerCard(title: "语言") {
                    Picker("语言", selection: $language) {
                        Text("跟随系统").tag(LanguageMode.system)
                        Text("中文").tag(LanguageMode.zh)
                        Text("English").tag(LanguageMode.en)
                    }
                    .pickerStyle(.segmented)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 16)
        }
        .background(WeChatColor.background)
        .navigationTitle("界面与显示")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // 二级页不保留底部 tab
    }

    private func pickerCard(title: LocalizedStringKey, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: WeChatSpacing.s) {
            Text(title)
                .font(WeChatFont.footnote)
                .foregroundStyle(WeChatColor.textSecondary)
            content()
        }
        .padding(WeChatSpacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WeChatColor.elevated)
        .clipShape(RoundedRectangle(cornerRadius: WeChatRadius.l, style: .continuous))
    }
}

#Preview {
    NavigationStack { AppearanceView() }
        .preferredColorScheme(.dark)
}
