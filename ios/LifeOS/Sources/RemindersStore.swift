import EventKit
import Foundation

struct AppleReminder: Identifiable, Equatable {
    let id: String          // EKReminder.calendarItemIdentifier
    let title: String
    let due: Date?
    let list: String
}

/// Apple Reminders through EventKit, on the device itself. This is the only place that can
/// really write to the Reminders app — the bridge cannot (see the note in lifeos-store.mjs).
@MainActor
final class RemindersStore: ObservableObject {
    enum Access { case unknown, granted, denied }

    @Published private(set) var items: [AppleReminder] = []
    @Published private(set) var access: Access = .unknown
    @Published var error: String?

    private let store = EKEventStore()
    private var observer: NSObjectProtocol?

    init() {
        updateAccess()
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

    private func updateAccess() {
        switch EKEventStore.authorizationStatus(for: .reminder) {
        case .fullAccess, .authorized: access = .granted
        case .notDetermined: access = .unknown
        default: access = .denied
        }
    }

    func start() async {
        if access == .unknown { await requestAccess() }
        await refresh()
    }

    func requestAccess() async {
        do {
            _ = try await store.requestFullAccessToReminders()
        } catch { self.error = error.localizedDescription }
        updateAccess()
        await refresh()
    }

    func refresh() async {
        updateAccess()
        guard access == .granted else { items = []; return }
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        let found: [AppleReminder] = await withCheckedContinuation { cont in
            store.fetchReminders(matching: predicate) { reminders in
                let mapped = (reminders ?? []).map { r in
                    AppleReminder(
                        id: r.calendarItemIdentifier,
                        title: r.title ?? "",
                        due: r.dueDateComponents.flatMap { Calendar.current.date(from: $0) },
                        list: r.calendar?.title ?? ""
                    )
                }
                cont.resume(returning: mapped)
            }
        }
        // dated ones first (soonest first), then undated, alphabetical
        items = found.sorted {
            switch ($0.due, $1.due) {
            case let (a?, b?): return a < b
            case (_?, nil): return true
            case (nil, _?): return false
            default: return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
            }
        }
    }

    func add(_ title: String) async {
        guard access == .granted, let calendar = store.defaultCalendarForNewReminders() else { return }
        let r = EKReminder(eventStore: store)
        r.title = title
        r.calendar = calendar
        do { try store.save(r, commit: true); error = nil }
        catch { self.error = error.localizedDescription }
        await refresh()
    }

    func complete(_ id: String) async {
        items.removeAll { $0.id == id }   // optimistic
        if let r = store.calendarItem(withIdentifier: id) as? EKReminder {
            r.isCompleted = true
            do { try store.save(r, commit: true); error = nil }
            catch { self.error = error.localizedDescription }
        }
        await refresh()
    }
}
