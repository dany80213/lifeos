import AppIntents
import EventKit

/// "Ehi Siri, chiedi a LifeOS" → Siri asks what you want, you say it, and the request goes to the same AI the
/// Home chat uses (the model assigned to "Home" in Profilo). The server-side agent can act on it — add reminders,
/// log expenses or meals, create events — and Siri reads the answer back.
struct AskLifeOSIntent: AppIntent {
    static var title: LocalizedStringResource = "Chiedi a LifeOS"
    static var description = IntentDescription("Parla con l'IA di LifeOS: può aggiungere promemoria, spese, pasti ed eventi.")

    @Parameter(title: "Cosa vuoi fare?", requestValueDialog: IntentDialog("Cosa vuoi che faccia?"))
    var request: String

    static var parameterSummary: some ParameterSummary { Summary("Chiedi a LifeOS \(\.$request)") }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let api = APIClient()
        guard api.hasSessionCookie else {
            return .result(value: "", dialog: "Apri LifeOS e accedi, poi riprova.")
        }
        let model = AppState.backendId(forModelName: AppState.assignedModelName(forSection: "home"))
        do {
            let reply = try await api.ask(request, model: model, section: "home") { _ in }
            let text = reply["text"].str.trimmingCharacters(in: .whitespacesAndNewlines)
            let spoken = text.isEmpty ? "Fatto." : text
            return .result(value: spoken, dialog: IntentDialog(stringLiteral: spoken))
        } catch {
            return .result(value: "", dialog: IntentDialog(stringLiteral: "Non riesco a raggiungere LifeOS: \(error.localizedDescription)"))
        }
    }
}

/// "Aggiungi un promemoria con LifeOS" — straight into the Apple Reminders app, no AI involved.
struct AddReminderIntent: AppIntent {
    static var title: LocalizedStringResource = "Aggiungi promemoria"
    static var description = IntentDescription("Aggiunge un promemoria all'app Promemoria di Apple.")

    @Parameter(title: "Promemoria", requestValueDialog: IntentDialog("Cosa devo ricordarti?"))
    var text: String

    static var parameterSummary: some ParameterSummary { Summary("Aggiungi il promemoria \(\.$text)") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let store = EKEventStore()
        guard (try? await store.requestFullAccessToReminders()) == true, let calendar = store.defaultCalendarForNewReminders() else {
            return .result(dialog: "Non ho accesso ai Promemoria: abilitalo in Impostazioni.")
        }
        let r = EKReminder(eventStore: store)
        r.title = text
        r.calendar = calendar
        try store.save(r, commit: true)
        return .result(dialog: "Ho aggiunto: \(text)")
    }
}

struct LifeOSShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskLifeOSIntent(),
            phrases: [
                "Chiedi a \(.applicationName)",
                "Parla con \(.applicationName)",
                "Dì a \(.applicationName)",
                "\(.applicationName) fai una cosa",
            ],
            shortTitle: "Chiedi a LifeOS",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: AddReminderIntent(),
            phrases: [
                "Aggiungi un promemoria con \(.applicationName)",
                "Ricordami una cosa con \(.applicationName)",
            ],
            shortTitle: "Aggiungi promemoria",
            systemImageName: "checklist"
        )
    }
}
