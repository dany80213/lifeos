import SwiftUI

@main
struct LifeOSApp: App {
    @StateObject private var app = AppState()
    @StateObject private var reminders = RemindersStore()
    @StateObject private var health = HealthStore()
    var body: some Scene {
        WindowGroup {
            RootView()
                #if os(macOS)
                .frame(minWidth: 1000, minHeight: 680)
                #endif
                .environmentObject(app)
                .environmentObject(reminders)
                .environmentObject(health)
                .preferredColorScheme(app.colorScheme)
                .tint(T.accent)
        }
        #if os(macOS)
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1180, height: 780)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Vai") {
                ForEach(Array(AppTab.allCases.enumerated()), id: \.element) { i, tab in
                    Button(tab.title) { NotificationCenter.default.post(name: .lifeosSelectTab, object: tab) }
                        .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
                }
                Divider()
                Button("Aggiorna") { Task { await app.refresh() } }.keyboardShortcut("r", modifiers: .command)
            }
        }
        #endif
    }
}

enum AppTab: String, CaseIterable, Hashable {
    case home, finanze, review, salute, profilo
    var title: String {
        switch self { case .home: "Home"; case .finanze: "Finanze"; case .review: "Review"; case .salute: "Salute"; case .profilo: "Profilo" }
    }
    var icon: String {
        switch self {
        case .home: "house.fill"; case .finanze: "eurosign.circle.fill"; case .review: "checkmark.seal.fill"
        case .salute: "heart.fill"; case .profilo: "person.crop.circle.fill"
        }
    }
}

extension Notification.Name { static let lifeosSelectTab = Notification.Name("lifeosSelectTab") }

struct RootView: View {
    @EnvironmentObject var app: AppState
    @EnvironmentObject var reminders: RemindersStore
    @EnvironmentObject var health: HealthStore
    var body: some View {
        if app.loggedIn {
            tabs
                .task { await app.refresh() }
                .task { await reminders.start() }
                .task { await health.start() }
        } else {
            LoginView()
        }
    }
}

extension RootView {
    @ViewBuilder fileprivate func screen(_ tab: AppTab) -> some View {
        switch tab {
        case .home: HomeView()
        case .finanze: FinanzeView()
        case .review: ReviewView()
        case .salute: SaluteView()
        case .profilo: ProfiloView()
        }
    }

    @ViewBuilder fileprivate var tabs: some View {
        #if os(iOS)
        TabView {
            ForEach(AppTab.allCases, id: \.self) { tab in
                screen(tab).tabItem { Label(tab.title, systemImage: tab.icon) }
            }
        }
        .modifier(MinimizingTabBar())
        #else
        MacShell { screen($0) }
        #endif
    }
}

struct LoginView: View {
    @EnvironmentObject var app: AppState
    @State private var user = "daniele"
    @State private var pass = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ZStack {
            Backdrop()
            VStack(spacing: 20) {
                Spacer()
                LogoMark(size: 96)
                Text("LifeOS").font(.system(size: 44, weight: .heavy)).foregroundStyle(T.text1)
                Text("Accedi per continuare").foregroundStyle(T.text2)
                Card {
                    Field(placeholder: "Utente", text: $user, keyboard: .asciiCapable)
                    Field(placeholder: "Password", text: $pass, secure: true)
                    if let error { Text(error).font(.footnote).foregroundStyle(T.red) }
                    Button {
                        Task {
                            busy = true; error = nil
                            error = await app.login(user, pass)
                            busy = false
                        }
                    } label: {
                        HStack { if busy { ProgressView().tint(.white) }; Text("Accedi") }.frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PillButtonStyle())
                    .disabled(busy || user.isEmpty || pass.isEmpty)
                }
                Spacer()
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 460)
        }
    }
}

#if os(iOS)
/// iOS 26: the glass tab bar collapses while scrolling down and returns on scroll up.
struct MinimizingTabBar: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) { content.tabBarMinimizeBehavior(.onScrollDown) } else { content }
    }
}
#endif
