import SwiftUI

struct HomeView: View {
    @EnvironmentObject var app: AppState
    @EnvironmentObject var reminders: RemindersStore
    @State private var newTodo = ""
    @State private var detail: DetailItem?
    @State private var briefingOpen = false
    @AppStorage("lifeos_visible_calendars") private var visibleRaw = ""   // "" = all

    private var today: String { Fmt.dayKey(app.now) }
    private var habitsToday: [JSON] {
        let dow = Calendar.current.component(.weekday, from: app.now) - 1   // JS getDay(): 0 = domenica
        return app.data["habits"].array.filter { h in
            let days = h["days"].ints
            return days.isEmpty || days.contains(dow)
        }
    }
    private var greeting: String {
        let h = Calendar.current.component(.hour, from: app.now)
        return h < 12 ? "Buongiorno, Daniele" : h < 18 ? "Buon pomeriggio, Daniele" : "Buonasera, Daniele"
    }
    private var calendars: [String] { app.data["calendarNames"].strings }
    private var visible: Set<String> {
        visibleRaw.isEmpty ? Set(calendars) : Set(visibleRaw.components(separatedBy: "|").filter { calendars.contains($0) })
    }

    var body: some View {
        Screen(title: "Home", chat: .home) {
            #if os(macOS)
            Row([2, 1]) { sessionCard; briefingCard }
            Row([1, 2]) { habitsCard; agendaCard }
            Row([1, 1]) {
                schoolCard("VERIFICHE", rows: upcoming(app.data["didupVerifiche"].array), titleKey: "materia", metaKey: "docente")
                schoolCard("COMPITI", rows: app.data["didupCompiti"].array, titleKey: "materia", metaKey: "compito")
            }
            automationsCard
            #else
            marketChips
            briefingCard
            sessionCard
            habitsCard
            agendaCard
            schoolCard("VERIFICHE", rows: upcoming(app.data["didupVerifiche"].array), titleKey: "materia", metaKey: "docente")
            schoolCard("COMPITI", rows: app.data["didupCompiti"].array, titleKey: "materia", metaKey: "compito")
            automationsCard
            #endif
        }
        .sheet(item: $detail) { DetailSheet(item: $0).presentationDetents([.medium, .large]) }
    }

    // MARK: briefing delle 6

    private func briefingSection(_ key: String) -> JSON? {
        app.briefing["sections"].array.first { $0["key"].str == key }
    }

    /// Markdown line → text, dropping the "- " bullet marker and keeping **bold**.
    private func md(_ line: String) -> AttributedString {
        (try? AttributedString(markdown: line, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(line)
    }
    private func bullets(_ text: String) -> [String] {
        text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("- ") }.map { String($0.dropFirst(2)) }
    }

    @ViewBuilder private var briefingCard: some View {
        if !app.briefing.isNull {
            let meteo = briefingSection("meteo")
            let impegni = briefingSection("impegni")
            let promemoria = briefingSection("promemoria")
            let generated = Fmt.date(app.briefing["generatedAtIso"].str)
            Button { briefingOpen = true } label: {
                Card {
                    HStack {
                        CardLabel("BRIEFING DELLE 6:00")
                        Spacer()
                        if let generated { Text(Fmt.it(generated, "d MMM · HH:mm")).font(.caption2).foregroundStyle(T.text3) }
                    }
                    if let meteo {
                        HStack(alignment: .top, spacing: 10) {
                            Text(meteo["emoji"].str).font(.title2)
                            Text(md(meteo["text"].str)).font(.subheadline).lineLimit(5).multilineTextAlignment(.leading)
                        }
                    }
                    let todo = (impegni.map { bullets($0["text"].str) } ?? []) + (promemoria.map { bullets($0["text"].str) } ?? [])
                    if !todo.isEmpty {
                        Divider().overlay(T.border)
                        Text("DA FARE OGGI").font(.caption2.weight(.bold)).tracking(1.2).foregroundStyle(T.text3)
                        ForEach(todo.prefix(5).indices, id: \.self) { i in
                            HStack(alignment: .top, spacing: 8) {
                                Text("•").foregroundStyle(T.accent)
                                Text(md(todo[i])).font(.subheadline).lineLimit(2).multilineTextAlignment(.leading)
                            }
                        }
                    }
                    HStack(spacing: 4) {
                        Text("Leggi tutto").font(.footnote.weight(.semibold))
                        Image(systemName: "chevron.right").font(.caption2)
                    }.foregroundStyle(T.accent)
                }
            }
            .buttonStyle(.plain)
            .sheet(isPresented: $briefingOpen) { BriefingSheet(briefing: app.briefing) }
        }
    }

    // MARK: detail builders

    private func eventDetail(_ e: JSON, start: Date) -> DetailItem {
        let end = Fmt.date(e["until"].str)
        var rows: [(String, String)] = [("Quando", Fmt.it(start, "EEEE d MMMM yyyy").capitalized)]
        rows.append(("Orario", Fmt.it(start, "HH:mm") + (end.map { " – " + Fmt.it($0, "HH:mm") } ?? "")))
        if let end { rows.append(("Durata", durationText(end.timeIntervalSince(start)))) }
        rows.append(("Calendario", e["calendar"].str))
        rows.append(("Luogo", e["location"].str))
        return DetailItem(kind: "EVENTO", title: e["title"].str, tint: color(for: e["calendar"].str), rows: rows)
    }

    private func schoolDetail(_ kind: String, _ r: JSON) -> DetailItem {
        let labels = ["materia": "Materia", "docente": "Docente", "compito": "Compito", "data": "Data", "descrizione": "Descrizione", "note": "Note"]
        var rows: [(String, String)] = []
        for key in ["data", "materia", "docente", "compito", "descrizione", "note"] {
            var v = r[key].str
            if key == "data" { v = longDate(v) }
            rows.append((labels[key] ?? key, v))
        }
        // anything else the registry sent that isn't shown above
        for (k, v) in r.dict.sorted(by: { $0.key < $1.key }) where labels[k] == nil && !["id", "esito"].contains(k) {
            if let text = v.string, !text.isEmpty { rows.append((k.capitalized, text)) }
        }
        let title = r["materia"].str.isEmpty ? kind.capitalized : r["materia"].str
        return DetailItem(kind: kind, title: title, tint: kind == "VERIFICA" ? T.red : T.amber, rows: rows)
    }

    private func longDate(_ s: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
        guard let d = f.date(from: String(s.prefix(10))) else { return s }
        return Fmt.it(d, "EEEE d MMMM yyyy").capitalized
    }

    private func durationText(_ secs: TimeInterval) -> String {
        let m = Int(secs / 60)
        return m >= 60 ? "\(m / 60) h" + (m % 60 > 0 ? " \(m % 60) min" : "") : "\(m) min"
    }

    // MARK: sections

    private var marketChips: some View {
        HStack(spacing: 10) {
            chip("BTC", app.data["marketPulse"]["btc"])
            chip("EUNL", app.data["marketPulse"]["eunl"])
        }.glassGroup()
    }
    private func chip(_ name: String, _ q: JSON) -> some View {
        HStack(spacing: 8) {
            Text(name).font(.caption.weight(.bold)).foregroundStyle(T.text3)
            Text(q["price"].isNull ? "—" : Fmt.eur(q["price"].num, decimals: q["price"].num < 1000 ? 2 : 0)).font(.subheadline.weight(.semibold))
            if !q["d24"].isNull {
                Text("\(q["d24"].num >= 0 ? "▲" : "▼") \(String(format: "%.1f", abs(q["d24"].num)))%")
                    .font(.caption.weight(.semibold)).foregroundStyle(q["d24"].num >= 0 ? T.green : T.red)
            }
        }
        .foregroundStyle(T.text1)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .adaptiveGlass(Capsule())
    }

    private var sessionCard: some View {
        Card {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    CardLabel("SESSIONE")
                    Text(greeting).font(.title3.weight(.bold))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Fmt.it(app.now, "HH:mm")).font(.title2.weight(.bold)).monospacedDigit()
                    Text(Fmt.it(app.now, "EEEE d MMMM").capitalized).font(.caption).foregroundStyle(T.text3)
                }
            }
            HStack(spacing: 8) {
                Field(placeholder: "Aggiungi una cosa da fare oggi…", text: $newTodo)
                    .onSubmit(addTodo)
                Button(action: addTodo) { Image(systemName: "plus").font(.headline.bold()) }
                    .buttonStyle(PillButtonStyle()).disabled(newTodo.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            todoList
        }
    }

    /// Apple Reminders first (the real app, via EventKit), then whatever Jarvis stored on the bridge.
    @ViewBuilder private var todoList: some View {
        let server = app.data["reminders"].array
        if reminders.access == .denied {
            VStack(alignment: .leading, spacing: 6) {
                Text("Per vedere e aggiungere i promemoria di Apple consenti l'accesso a Promemoria.")
                    .font(.footnote).foregroundStyle(T.text3)
                Button("Apri Impostazioni") { SystemSettings.openPrivacy() }.font(.footnote.weight(.semibold))
            }
        } else if reminders.access == .unknown {
            Button("Collega Promemoria di Apple") { Task { await reminders.requestAccess() } }
                .buttonStyle(PillButtonStyle())
        }
        if reminders.items.isEmpty && server.isEmpty && reminders.access != .unknown {
            Text("Nessun promemoria.").font(.subheadline).foregroundStyle(T.text3)
        }
        ForEach(reminders.items) { r in
            todoRow(title: r.title, sub: reminderSub(r), apple: true) { Task { await reminders.complete(r.id) } }
        }
        ForEach(server.indices, id: \.self) { i in
            let t = server[i]
            todoRow(title: t["text"].str, sub: nil, apple: false) { Task { await app.completeReminder(t["id"].int) } }
        }
    }

    private func reminderSub(_ r: AppleReminder) -> String? {
        guard let due = r.due else { return nil }
        let cal = Calendar.current
        let day = cal.isDateInToday(due) ? "Oggi" : cal.isDateInTomorrow(due) ? "Domani" : Fmt.it(due, "d MMM")
        let hasTime = cal.component(.hour, from: due) != 0 || cal.component(.minute, from: due) != 0
        return hasTime ? "\(day) · \(Fmt.it(due, "HH:mm"))" : day
    }

    private func todoRow(title: String, sub: String?, apple: Bool, done: @escaping () -> Void) -> some View {
        Button(action: done) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 6).strokeBorder(T.border, lineWidth: 1.5).frame(width: 22, height: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).foregroundStyle(T.text1).multilineTextAlignment(.leading)
                    if let sub { Text(sub).font(.caption).foregroundStyle(T.text3) }
                }
                Spacer()
                if apple { Image(systemName: "checklist").font(.caption).foregroundStyle(T.text3) }
            }
        }.buttonStyle(.plain)
    }

    private func addTodo() {
        let text = newTodo.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        newTodo = ""
        Task {
            if reminders.access == .granted { await reminders.add(text) }
            else { await app.addReminder(text) }   // no Reminders access: keep it on the bridge
        }
    }

    private var habitsCard: some View {
        let done = habitsToday.filter { $0["lastDoneDate"].str == today }.count
        let pct = habitsToday.isEmpty ? 0 : Double(done) / Double(habitsToday.count)
        return Card {
            HStack {
                CardLabel("ABITUDINI DI OGGI")
                Spacer()
                ZStack {
                    Ring(value: pct, lineWidth: 6)
                    Text("\(Int((pct * 100).rounded()))%").font(.caption2.weight(.bold))
                }.frame(width: 46, height: 46)
            }
            if habitsToday.isEmpty {
                Text("Nessuna abitudine per oggi. Aggiungile da Profilo.").font(.subheadline).foregroundStyle(T.text3)
            }
            ForEach(habitsToday.indices, id: \.self) { i in
                let h = habitsToday[i]
                let isDone = h["lastDoneDate"].str == today
                Button {
                    Task {
                        _ = await app.financeOp("habits", "update", id: h["id"].int,
                                                data: ["lastDoneDate": isDone ? nil : .string(today)])
                    }
                } label: {
                    HStack(spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 6).fill(isDone ? T.accent : .clear)
                            RoundedRectangle(cornerRadius: 6).strokeBorder(isDone ? T.accent : T.border, lineWidth: 1.5)
                            if isDone { Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white) }
                        }.frame(width: 24, height: 24)
                        let n = h["doneCount"].int
                        Text("\(h["name"].str) · \(n) \(n == 1 ? "volta" : "volte")")
                            .strikethrough(isDone).foregroundStyle(isDone ? T.text2 : T.text1)
                        Spacer()
                    }
                }.buttonStyle(.plain)
            }
        }
    }

    private func color(for calendar: String) -> Color {
        let raw = app.data["calendarColors"][calendar].str
        guard raw.hasPrefix("#"), raw.count >= 7, let v = UInt32(raw.dropFirst().prefix(6), radix: 16) else { return T.accent }
        return Color(red: Double((v >> 16) & 255) / 255, green: Double((v >> 8) & 255) / 255, blue: Double(v & 255) / 255)
    }

    private var agendaCard: some View {
        let weekEnd = Calendar.current.date(byAdding: .day, value: 7, to: Calendar.current.startOfDay(for: app.now)) ?? app.now
        let events = app.data["events"].array
            .filter { visible.contains($0["calendar"].str) || calendars.isEmpty }
            .compactMap { e -> (Date, JSON)? in Fmt.date(e["when"].str).map { ($0, e) } }
            .filter { $0.0 >= Calendar.current.startOfDay(for: app.now) && $0.0 < weekEnd }
            .sorted { $0.0 < $1.0 }
        let groups = Dictionary(grouping: events) { Calendar.current.startOfDay(for: $0.0) }
        return Card {
            HStack {
                CardLabel("AGENDA · 7 GIORNI")
                Spacer()
                if !calendars.isEmpty {
                    Menu {
                        ForEach(calendars, id: \.self) { name in
                            Button {
                                var set = visible
                                if set.contains(name) { set.remove(name) } else { set.insert(name) }
                                visibleRaw = set.sorted().joined(separator: "|")
                                app.pushProfile(visibleCalendars: set.sorted())
                            } label: { Label(name, systemImage: visible.contains(name) ? "checkmark" : "") }
                        }
                    } label: { Image(systemName: "line.3.horizontal.decrease.circle") }
                }
            }
            if events.isEmpty { Text("Nessun evento in arrivo.").font(.subheadline).foregroundStyle(T.text3) }
            // A week of lessons runs long: cap the card's height and let the list scroll inside it.
            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 14) {
                ForEach(groups.keys.sorted(), id: \.self) { day in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(Fmt.it(day, "EEEE d MMMM").capitalized).font(.footnote.weight(.semibold)).foregroundStyle(T.text2)
                        ForEach((groups[day] ?? []).indices, id: \.self) { i in
                            let (d, e) = groups[day]![i]
                            Button { detail = eventDetail(e, start: d) } label: {
                            HStack(alignment: .top, spacing: 10) {
                                RoundedRectangle(cornerRadius: 2).fill(color(for: e["calendar"].str)).frame(width: 4)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(e["title"].str).font(.subheadline.weight(.semibold))
                                    HStack(spacing: 6) {
                                        Text(Fmt.it(d, "HH:mm") + (Fmt.date(e["until"].str).map { "–" + Fmt.it($0, "HH:mm") } ?? ""))
                                        if !e["location"].str.isEmpty { Text("· " + e["location"].str).lineLimit(1) }
                                    }.font(.caption).foregroundStyle(T.text3)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(T.text3)
                            }
                            .contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    }
                }
                }
            }
            .frame(maxHeight: 340)
        }
    }

    private func schoolCard(_ label: String, rows: [JSON], titleKey: String, metaKey: String) -> some View {
        Group {
            if !rows.isEmpty {
                Card {
                    CardLabel(label)
                    ForEach(rows.prefix(6).indices, id: \.self) { i in
                        let r = rows[i]
                        Button { detail = schoolDetail(label == "VERIFICHE" ? "VERIFICA" : "COMPITO", r) } label: {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r[titleKey].str.isEmpty ? label.capitalized : r[titleKey].str).font(.subheadline.weight(.semibold))
                                if !r[metaKey].str.isEmpty {
                                    Text(r[metaKey].str).font(.caption).foregroundStyle(T.text3).lineLimit(2)
                                }
                            }
                            Spacer()
                            Text(dateLabel(r["data"].str)).font(.caption.weight(.semibold))
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(T.accent.opacity(0.18), in: Capsule()).foregroundStyle(T.accent)
                        }
                        .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
    }

    /// Tests whose day has already passed are dropped; today's stay until the day is over.
    private func upcoming(_ rows: [JSON]) -> [JSON] {
        let startOfToday = Calendar.current.startOfDay(for: app.now)
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
        return rows.filter { r in
            guard let d = f.date(from: String(r["data"].str.prefix(10))) else { return true }   // no readable date: keep
            return d >= startOfToday
        }
    }

    private func dateLabel(_ s: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
        guard let d = f.date(from: String(s.prefix(10))) else { return s }
        let diff = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: app.now), to: d).day ?? 0
        switch diff { case 0: return "Oggi"; case 1: return "Domani"; default: return Fmt.it(d, "d MMM") }
    }

    private var automationsCard: some View {
        let rows = app.data["automations"].array
        return Group {
            if !rows.isEmpty {
                Card {
                    CardLabel("AUTOMAZIONI")
                    ForEach(rows.indices, id: \.self) { i in
                        let a = rows[i]
                        HStack(alignment: .center, spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(a["time"].str).font(.caption.weight(.bold)).foregroundStyle(a["failed"].bool ? T.red : T.accent)
                                Text(a["action"].str).font(.subheadline).lineLimit(3)
                                if a["failed"].bool { Text("Ultima esecuzione fallita").font(.caption).foregroundStyle(T.red) }
                            }
                            Spacer()
                            if a["editable"].bool {
                                Toggle("", isOn: Binding(
                                    get: { a["enabled"].bool },
                                    set: { v in Task { await app.setAutomation(a["id"].str, enabled: v) } }
                                )).labelsHidden()
                            } else {
                                // systemd timers need root to change: show their state only
                                Text(a["enabled"].bool ? "Attiva" : "Ferma").font(.caption.weight(.semibold))
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background((a["enabled"].bool ? T.green : T.text3).opacity(0.18), in: Capsule())
                                    .foregroundStyle(a["enabled"].bool ? T.green : T.text3)
                            }
                        }
                        if i < rows.count - 1 { Divider().overlay(T.border) }
                    }
                }
            }
        }
    }
}

// MARK: - Detail modal

struct DetailItem: Identifiable {
    let id = UUID()
    let kind: String
    let title: String
    let tint: Color
    let rows: [(String, String)]
}

struct DetailSheet: View {
    let item: DetailItem
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ZStack {
                Backdrop()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(alignment: .top, spacing: 12) {
                            RoundedRectangle(cornerRadius: 3).fill(item.tint).frame(width: 5)
                            VStack(alignment: .leading, spacing: 4) {
                                CardLabel(item.kind)
                                Text(item.title).font(.title2.weight(.bold)).foregroundStyle(T.text1)
                            }
                        }
                        Card {
                            let shown = item.rows.filter { !$0.1.isEmpty }
                            ForEach(shown.indices, id: \.self) { i in
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(shown[i].0.uppercased()).font(.caption2.weight(.bold)).tracking(1).foregroundStyle(T.text3)
                                    Text(shown[i].1).font(.body).textSelection(.enabled)
                                }
                                if i < shown.count - 1 { Divider().overlay(T.border) }
                            }
                        }
                    }.padding(16)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Chiudi") { dismiss() } } }
        }
    }
}

// MARK: - Full briefing

struct BriefingSheet: View {
    let briefing: JSON
    @Environment(\.dismiss) private var dismiss

    private func md(_ line: String) -> AttributedString {
        (try? AttributedString(markdown: line, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(line)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Backdrop()
                ScrollView {
                    VStack(spacing: 14) {
                        ForEach(briefing["sections"].array.indices, id: \.self) { i in
                            let sec = briefing["sections"].array[i]
                            Card {
                                Text("\(sec["emoji"].str) \(sec["title"].str.uppercased())")
                                    .font(.caption.weight(.bold)).tracking(1.2).foregroundStyle(T.text3)
                                ForEach(sec["text"].str.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }, id: \.self) { line in
                                    if line.hasPrefix("- ") {
                                        HStack(alignment: .top, spacing: 8) {
                                            Text("•").foregroundStyle(T.accent)
                                            Text(md(String(line.dropFirst(2)))).font(.subheadline)
                                        }
                                    } else {
                                        Text(md(line)).font(.subheadline)
                                    }
                                }
                            }
                        }
                    }.padding(16)
                }
            }
            .navigationTitle("Briefing del mattino")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Chiudi") { dismiss() } } }
        }
    }
}
