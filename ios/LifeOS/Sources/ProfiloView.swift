import SwiftUI

struct ProfiloView: View {
    @EnvironmentObject var app: AppState
    @Environment(\.openURL) private var openURL
    @State private var newHabit = ""
    @State private var newDays: Set<Int> = []
    @State private var geminiKey = ""
    @State private var keyState = ""

    /// "LifeOS 1.0.0 (build 1)" — the numbers come from VERSION via project.yml, see CHANGELOG.md.
    private static var versionLabel: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "?"
        let b = info?["CFBundleVersion"] as? String ?? "?"
        return "LifeOS \(v) (build \(b))"
    }

    private var personal: JSON { app.settings["profile"]["personal"] }
    private var displayName: String {
        let n = [personal["nome"].str, personal["cognome"].str].filter { !$0.isEmpty }.joined(separator: " ")
        return n.isEmpty ? "Daniele" : n
    }
    private var displaySub: String {
        let parts = [personal["ruolo"].str, personal["citta"].str].filter { !$0.isEmpty }
        return parts.isEmpty ? "Tocca per completare il profilo" : parts.joined(separator: " · ")
    }

    private static let dayNames = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"]
    private static let order = [1, 2, 3, 4, 5, 6, 0]

    var body: some View {
        Screen(title: "Profilo") {
            #if os(macOS)
            Row([1, 1, 1]) { profileLinkCard; appearanceCard; passkeyCard }
            Row([1, 1, 1]) { habitsCard; aiCard; fatsecretCard }
            aboutCard
            #else
            profileLinkCard
            habitsCard
            aiCard
            fatsecretCard
            passkeyCard
            appearanceCard
            aboutCard
            #endif
        }
        .onAppear { geminiKey = app.settings["geminiApiKey"].str }
        .onChange(of: app.settings) { _, s in if geminiKey.isEmpty { geminiKey = s["geminiApiKey"].str } }
    }

    private var profileLinkCard: some View {
            PushLink { ProfileInfoView() } label: {
                Card {
                    HStack(spacing: 14) {
                        ProfileAvatar(size: 56)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(displayName).font(.title3.weight(.bold))
                            Text(displaySub).font(.subheadline).foregroundStyle(T.text3)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(T.text3)
                    }
                }
            }.buttonStyle(.plain)
    }

    private var aboutCard: some View {
            Card {
                PushLink { AboutView() } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "info.circle.fill").foregroundStyle(T.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Informazioni").font(.subheadline.weight(.semibold))
                            Text(Self.versionLabel).font(.caption).foregroundStyle(T.text3)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(T.text3)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
                Divider().overlay(T.border)
                Button("Esci", role: .destructive) { Task { await app.logout() } }
            }
    }

    private var habitsCard: some View {
        let habits = app.data["habits"].array
        return Card {
            CardLabel("ABITUDINI")
            if habits.isEmpty { Text("Nessuna abitudine.").font(.subheadline).foregroundStyle(T.text3) }
            ForEach(habits.indices, id: \.self) { i in
                let h = habits[i]
                let days = Set(h["days"].ints)
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(h["name"].str).font(.subheadline.weight(.semibold))
                        Spacer()
                        Button(role: .destructive) { Task { _ = await app.financeOp("habits", "remove", id: h["id"].int) } } label: {
                            Image(systemName: "trash").font(.footnote).foregroundStyle(T.text3)
                        }.buttonStyle(.plain)
                    }
                    dayPicker(days) { new in
                        Task { _ = await app.financeOp("habits", "update", id: h["id"].int, data: ["days": .array(new.sorted().map { .number(Double($0)) })]) }
                    }
                    Text(days.isEmpty ? "Ogni giorno" : "Solo nei giorni selezionati").font(.caption).foregroundStyle(T.text3)
                }
                Divider().overlay(T.border)
            }
            Field(placeholder: "Nuova abitudine", text: $newHabit)
            dayPicker(newDays) { newDays = $0 }
            Button("Aggiungi") {
                let name = newHabit.trimmingCharacters(in: .whitespaces)
                let days = newDays.sorted()
                newHabit = ""; newDays = []
                Task { _ = await app.financeOp("habits", "add", data: ["name": .string(name), "days": .array(days.map { .number(Double($0)) })]) }
            }.buttonStyle(PillButtonStyle()).disabled(newHabit.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private func dayPicker(_ selected: Set<Int>, _ onChange: @escaping (Set<Int>) -> Void) -> some View {
        HStack(spacing: 6) {
            ForEach(Self.order, id: \.self) { d in
                let on = selected.contains(d)
                Button {
                    var s = selected
                    if on { s.remove(d) } else { s.insert(d) }
                    onChange(s)
                } label: {
                    Text(Self.dayNames[d]).font(.caption2.weight(.bold)).frame(maxWidth: .infinity).padding(.vertical, 8)
                        .adaptiveGlass(RoundedRectangle(cornerRadius: 10, style: .continuous), tint: on ? T.accent : nil, interactive: true, fallback: T.glassSoft)
                        .foregroundStyle(on ? Color.white : T.text2)
                }.buttonStyle(.plain)
            }
        }
    }

    private var aiCard: some View {
        Card {
            CardLabel("ASSISTENTE PER SEZIONE")
            ForEach([("home", "Home"), ("finanze", "Finanze"), ("investimenti", "Investimenti"), ("salute", "Salute"), ("review", "Review")], id: \.0) { key, label in
                HStack {
                    Text(label).font(.subheadline)
                    Spacer()
                    Picker(label, selection: Binding(
                        get: { app.sectionAssignments[key] ?? "Claude" },
                        set: { var a = app.sectionAssignments; a[key] = $0; app.sectionAssignments = a }
                    )) { ForEach(AppState.aiModels, id: \.self) { Text($0).tag($0) } }.tint(T.accent)
                }
            }
            Text("Chiave API Gemini").font(.caption).foregroundStyle(T.text3)
            Field(placeholder: "Incolla qui la chiave", text: $geminiKey, secure: true)
            HStack {
                Button("Salva chiave") {
                    Task { keyState = "…"; await app.saveSettings(["geminiApiKey": .string(geminiKey)]); keyState = app.error == nil ? "Salvata" : "Errore" }
                }.buttonStyle(PillButtonStyle())
                Text(keyState).font(.caption).foregroundStyle(T.text3)
            }
        }
    }

    private var fatsecretCard: some View {
        let connected = app.data["fatsecretConnected"].bool
        return Card {
            CardLabel("FATSECRET")
            HStack {
                Circle().fill(connected ? T.green : T.text3).frame(width: 8, height: 8)
                Text(connected ? "Diario collegato" : "Non collegato").font(.subheadline)
                Spacer()
                if connected {
                    Button("Scollega", role: .destructive) {
                        Task { _ = await app.mutate { try await app.api.request("/api/lifeos-fatsecret-disconnect", method: "POST") } }
                    }.font(.footnote)
                } else if let url = URL(string: app.api.base + "/api/lifeos-fatsecret-connect") {
                    Button("Collega") { openURL(url) }.font(.footnote)
                }
            }
            if !connected {
                Text("Si apre Safari per l'autorizzazione: accedi a LifeOS lì se richiesto.").font(.caption).foregroundStyle(T.text3)
            }
        }
    }

    /// Passkeys are created and managed on the web page (served by the bridge); Safari stores them in iCloud Keychain.
    private var passkeyCard: some View {
        Card {
            CardLabel("PASSKEY")
            Text("Entra nella web app con Face ID o Touch ID, senza password. Le passkey si salvano nel Portachiavi iCloud e funzionano su tutti i tuoi dispositivi Apple.")
                .font(.footnote).foregroundStyle(T.text2)
            if let url = URL(string: app.api.base + "/passkeys") {
                Button("Gestisci passkey") { openURL(url) }.buttonStyle(PillButtonStyle())
            }
            Text("Si apre Safari: se richiesto accedi una volta con la password. L'app usa la password; le passkey valgono per la web.")
                .font(.caption).foregroundStyle(T.text3)
        }
    }

    private var appearanceCard: some View {
        Card {
            CardLabel("TEMA")
            Picker("Tema", selection: Binding(get: { app.themePref }, set: { app.themePref = $0; app.pushProfile(theme: $0) })) {
                Text("Scuro").tag("dark"); Text("Chiaro").tag("light"); Text("Sistema").tag("system")
            }.pickerStyle(.segmented)
        }
    }
}
