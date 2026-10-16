import Foundation
import UserNotifications

/// Local notifications: the 06:00 AI briefing and "verifica domani" the evening before.
///
/// They are scheduled on the device from what the app last loaded, so they need no push server.
/// The catch is that a local notification cannot fetch anything at 06:00: its text is fixed when it
/// is scheduled. The 06:00 one therefore just announces the briefing; the content is the Home card.
@MainActor
final class NotificationsStore: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    private enum Key {
        static let briefing = "lifeos_notif_briefing"
        static let hour = "lifeos_notif_briefing_hour"
        static let minute = "lifeos_notif_briefing_minute"
        static let verifiche = "lifeos_notif_verifiche"
    }
    private static let idPrefix = "lifeos."

    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @Published var briefingOn: Bool { didSet { UserDefaults.standard.set(briefingOn, forKey: Key.briefing) } }
    @Published var verificheOn: Bool { didSet { UserDefaults.standard.set(verificheOn, forKey: Key.verifiche) } }
    @Published var briefingTime: Date {
        didSet {
            let c = Calendar.current.dateComponents([.hour, .minute], from: briefingTime)
            UserDefaults.standard.set(c.hour ?? 6, forKey: Key.hour)
            UserDefaults.standard.set(c.minute ?? 0, forKey: Key.minute)
        }
    }

    private let center = UNUserNotificationCenter.current()
    private var lastVerifiche: [JSON] = []

    override init() {
        let d = UserDefaults.standard
        briefingOn = d.bool(forKey: Key.briefing)
        verificheOn = d.bool(forKey: Key.verifiche)
        var c = DateComponents(); c.hour = d.object(forKey: Key.hour) as? Int ?? 6; c.minute = d.object(forKey: Key.minute) as? Int ?? 0
        briefingTime = Calendar.current.date(from: c) ?? Date()
        super.init()
        center.delegate = self
    }

    var allowed: Bool { authorization == .authorized || authorization == .provisional }

    func refreshAuthorization() async {
        authorization = await center.notificationSettings().authorizationStatus
    }

    /// Asks iOS for permission the first time something is switched on. Returns whether it was granted.
    @discardableResult
    func ensureAuthorized() async -> Bool {
        await refreshAuthorization()
        if authorization == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            await refreshAuthorization()
        }
        return allowed
    }

    /// Rebuilds everything this app schedules. Cheap, so it runs after every data refresh and settings change.
    func reschedule(verifiche: [JSON]? = nil) async {
        if let verifiche { lastVerifiche = verifiche }
        await refreshAuthorization()
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(Self.idPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: pending)
        guard allowed else { return }

        if briefingOn {
            var c = Calendar.current.dateComponents([.hour, .minute], from: briefingTime)
            c.second = 0
            let content = UNMutableNotificationContent()
            content.title = "Resoconto del mattino"
            content.body = "Il resoconto IA è pronto: meteo, mercati, impegni e promemoria di oggi."
            content.sound = .default
            content.userInfo = ["tab": "home"]
            try? await center.add(UNNotificationRequest(
                identifier: Self.idPrefix + "briefing",
                content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: c, repeats: true)))
        }

        if verificheOn {
            let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
            let cal = Calendar.current
            for v in lastVerifiche.prefix(40) {
                guard let day = f.date(from: String(v["data"].str.prefix(10))),
                      let eve = cal.date(byAdding: .day, value: -1, to: day),
                      let fire = cal.date(bySettingHour: 20, minute: 0, second: 0, of: eve),
                      fire > Date() else { continue }
                let materia = v["materia"].str
                let docente = v["docente"].str
                let content = UNMutableNotificationContent()
                content.title = "Verifica domani"
                content.body = [materia.isEmpty ? "Verifica" : materia, docente].filter { !$0.isEmpty }.joined(separator: " — ")
                content.sound = .default
                content.userInfo = ["tab": "home"]
                let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: fire)
                try? await center.add(UNNotificationRequest(
                    identifier: Self.idPrefix + "verifica." + String(v["data"].str.prefix(10)) + "." + materia,
                    content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: c, repeats: false)))
            }
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    /// Show the banner even while the app is open.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions { [.banner, .sound] }

    /// Tapping one goes to the Home tab.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.notification.request.content.userInfo["tab"] as? String == "home" else { return }
        await MainActor.run { NotificationCenter.default.post(name: .lifeosSelectTab, object: AppTab.home) }
    }
}
