import Foundation
import SwiftUI

enum AISection: String { case home, finanze, investimenti, salute, review }

@MainActor
final class AppState: ObservableObject {
    let api = APIClient()
    @Published var loggedIn = false
    @Published var data: JSON = .null
    @Published var loading = false
    @Published var error: String?
    @Published var settings: JSON = .null
    @Published var briefing: JSON = .null     // the 06:00 Telegram briefing, see /api/lifeos-briefing
    @Published var now = Date()

    // Per-viewer prefs, same keys as the web client.
    @AppStorage("lifeos_theme") var themePref = "dark"      // dark | light | system

    private var applyingProfile = false

    init() {
        loggedIn = api.hasSessionCookie
        // iCloud key-value store: the same profile, so a new device starts configured before the server answers.
        if let raw = NSUbiquitousKeyValueStore.default.string(forKey: "lifeos_profile"),
           let json = try? JSONDecoder().decode(JSON.self, from: Data(raw.utf8)) { applyProfile(json) }
        NotificationCenter.default.addObserver(forName: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
                                               object: NSUbiquitousKeyValueStore.default, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self,
                      let raw = NSUbiquitousKeyValueStore.default.string(forKey: "lifeos_profile"),
                      let json = try? JSONDecoder().decode(JSON.self, from: Data(raw.utf8)) else { return }
                self.applyProfile(json)
            }
        }
        NSUbiquitousKeyValueStore.default.synchronize()
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.now = Date() }
        }
    }

    var colorScheme: ColorScheme? {
        switch themePref { case "light": return .light; case "system": return nil; default: return .dark }
    }

    // MARK: session

    func login(_ user: String, _ pass: String) async -> String? {
        do {
            try await api.login(username: user, password: pass)
            loggedIn = true
            await refresh()
            return nil
        } catch { return error.localizedDescription }
    }

    func logout() async {
        await api.logout()
        loggedIn = false
        data = .null
    }

    private func handle(_ err: Error) {
        if err is CancellationError { return }
        if case APIError.unauthorized = err { loggedIn = false }
        error = err.localizedDescription
    }

    // MARK: data

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            var fresh = try await api.request("/api/lifeos-data")
            fresh = keepingLastQuotes(fresh)
            data = fresh
            settings = (try? await api.request("/api/lifeos-settings")) ?? settings
            if !settings["profile"].isNull { applyProfile(settings["profile"]) }
            if let b = try? await api.request("/api/lifeos-briefing") { briefing = b["briefing"] }
            error = nil
        } catch { handle(error) }
    }

    /// CoinGecko's free tier rate-limits the bridge, which then omits a quote from marketPulse for
    /// that one response. Keep showing the last good one instead of blanking the chip.
    private func keepingLastQuotes(_ fresh: JSON) -> JSON {
        guard case .object(var root) = fresh else { return fresh }
        var pulse = fresh["marketPulse"].dict
        let key = "lifeos_last_pulse"
        let cached = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode([String: JSON].self, from: $0) } ?? [:]
        for name in ["btc", "eunl"] {
            if pulse[name]?["price"].double == nil, let old = cached[name] { pulse[name] = old }
        }
        UserDefaults.standard.set(try? JSONEncoder().encode(pulse), forKey: key)
        root["marketPulse"] = .object(pulse)
        return .object(root)
    }

    // MARK: profile (server + iCloud)

    /// Server `settings.profile` → this device. The web pages read the very same object.
    func applyProfile(_ p: JSON) {
        applyingProfile = true
        defer { applyingProfile = false }
        // "Sistema" is iOS-only: if this device follows the system, don't override it with the web's light/dark.
        if let t = p["theme"].string, t == "dark" || t == "light", themePref != "system" { themePref = t }
        if case .object(let o) = p["sectionAI"] {
            var merged = sectionAssignments
            for (k, v) in o { if let name = v.string { merged[k] = name.hasPrefix("Qwen") ? Self.localModel : name } }
            sectionAssignments = merged
        }
        if let names = p["visibleCalendars"].isNull ? nil : p["visibleCalendars"].strings {
            UserDefaults.standard.set(names.sorted().joined(separator: "|"), forKey: "lifeos_visible_calendars")
        }
    }

    /// This device → server (visible on the web) and iCloud (other devices).
    func pushProfile(theme: String? = nil, sectionAI: [String: String]? = nil, visibleCalendars: [String]? = nil) {
        guard !applyingProfile, loggedIn else { return }
        var fields: [String: JSON] = [:]
        if let theme, theme == "dark" || theme == "light" { fields["theme"] = .string(theme) }
        if let sectionAI { fields["sectionAI"] = .object(sectionAI.mapValues { .string($0) }) }
        if let visibleCalendars { fields["visibleCalendars"] = .array(visibleCalendars.map { .string($0) }) }
        guard !fields.isEmpty else { return }
        Task {
            if let s = try? await api.request("/api/lifeos-settings", method: "POST", body: ["profile": .object(fields)]) {
                settings = s
                if let data = try? JSONEncoder().encode(s["profile"]), let str = String(data: data, encoding: .utf8) {
                    NSUbiquitousKeyValueStore.default.set(str, forKey: "lifeos_profile")
                    NSUbiquitousKeyValueStore.default.synchronize()
                }
            }
        }
    }

    /// Saves personal details / photo into settings.profile (shared with the web app).
    func saveProfile(_ fields: [String: JSON]) async -> Bool {
        do {
            settings = try await api.request("/api/lifeos-settings", method: "POST", body: ["profile": .object(fields)])
            error = nil
            return true
        } catch { handle(error); return false }
    }

    /// Runs a mutation, then re-reads the real state; reports errors instead of swallowing them.
    @discardableResult
    func mutate(_ work: () async throws -> JSON) async -> JSON? {
        do {
            let r = try await work()
            await refresh()
            return r
        } catch { handle(error); return nil }
    }

    func financeOp(_ collection: String, _ op: String, id: Int? = nil, lotId: Int? = nil, data d: JSON? = nil) async -> JSON? {
        var body: [String: JSON] = ["collection": .string(collection), "op": .string(op)]
        if let id { body["id"] = .number(Double(id)) }
        if let lotId { body["lotId"] = .number(Double(lotId)) }
        if let d { body["data"] = d }
        return await mutate { try await api.request("/api/lifeos-finance", method: "POST", body: .object(body)) }
    }

    func addReminder(_ text: String) async {
        _ = await mutate { try await api.request("/api/lifeos-reminder-add", method: "POST", body: ["text": .string(text), "due_iso": nil]) }
    }
    func completeReminder(_ id: Int) async {
        // optimistic removal, like the web page
        if case .object(var o) = data {
            o["reminders"] = .array(data["reminders"].array.filter { $0["id"].int != id })
            data = .object(o)
        }
        _ = await mutate { try await api.request("/api/lifeos-reminder-complete", method: "POST", body: ["id": .number(Double(id))]) }
    }

    func setAutomation(_ id: String, enabled: Bool) async {
        _ = await mutate {
            try await api.request("/api/lifeos-automation-toggle", method: "POST", body: ["id": .string(id), "enabled": .bool(enabled)])
        }
    }

    func saveSettings(_ fields: JSON) async {
        do { settings = try await api.request("/api/lifeos-settings", method: "POST", body: fields); await refresh() }
        catch { handle(error) }
    }

    // MARK: AI sections

    static let localModel = "Groq"   // the bridge still calls this backend "qwen"; it is Groq (gpt-oss) now
    static let geminiModel = "Gemini"
    static let aiModels = ["Claude", "Gemini", localModel]
    private let sectionsKey = "lifeos_section_ai"
    private let defaults: [String: String] = ["home": "Claude", "finanze": "Claude", "investimenti": "Claude", "salute": "Claude", "review": "Gemini"]

    var sectionAssignments: [String: String] {
        get {
            guard let raw = UserDefaults.standard.data(forKey: sectionsKey),
                  let saved = try? JSONDecoder().decode([String: String].self, from: raw) else { return defaults }
            // assignments saved before the rename pointed at "Qwen2.5 (locale)"
            return defaults.merging(saved.mapValues { $0.hasPrefix("Qwen") ? Self.localModel : $0 }) { $1 }
        }
        set {
            objectWillChange.send()
            UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: sectionsKey)
            pushProfile(sectionAI: newValue)
        }
    }

    /// Which bridge backend answers a section: the model chosen in Profilo → "jarvis" (full agent with tools),
    /// "qwen" (Groq) or "gemini". Static so Siri / App Intents can use it without an AppState.
    nonisolated static func backendId(forModelName name: String?) -> String {
        guard let name else { return "jarvis" }
        if name == "Groq" || name.hasPrefix("Qwen") { return "qwen" }
        if name == "Gemini" { return "gemini" }
        return "jarvis"
    }

    nonisolated static func assignedModelName(forSection key: String) -> String? {
        let defaults = ["home": "Claude", "finanze": "Claude", "investimenti": "Claude", "salute": "Claude", "review": "Gemini"]
        guard let raw = UserDefaults.standard.data(forKey: "lifeos_section_ai"),
              let saved = try? JSONDecoder().decode([String: String].self, from: raw), let v = saved[key] else { return defaults[key] }
        return v
    }

    func ask(_ text: String, section: AISection?, model modelName: String? = nil, onDelta: @escaping (String) -> Void = { _ in }) async throws -> JSON {
        let model = Self.backendId(forModelName: modelName ?? section.flatMap { sectionAssignments[$0.rawValue] })
        let reply = try await api.ask(text, model: model, section: section?.rawValue, onDelta: onDelta)
        if !reply["action"].isNull && !reply["data"].isNull { await refresh() }
        return reply
    }
}
