import SwiftUI
import Charts

struct SaluteView: View {
    @EnvironmentObject var app: AppState
    @EnvironmentObject var health: HealthStore
    @State private var showMeal = false
    @State private var showWorkout = false
    @State private var trend: JSON = .null
    @State private var trendError: String?
    @State private var trendLoading = false
    @State private var pickedDay: Date?       // nil = oggi (FatSecret history)
    @State private var syncedAt: Date?

    private var targets: JSON { app.settings["nutritionTargets"].isNull ? ["kcal": 2400, "protein": 160, "carbs": 280, "fat": 80] : app.settings["nutritionTargets"] }
    private var cal: Calendar { Calendar.current }
    private var allMeals: [JSON] { app.data["meals"].array }

    private var today: Date { cal.startOfDay(for: app.now) }
    private var selectedDay: Date { pickedDay ?? today }
    private var isToday: Bool { cal.isDate(selectedDay, inSameDayAs: today) }
    /// Today, then the most recent days that actually have logged meals (FatSecret is not logged every day).
    private var chipDays: [Date] {
        let logged = Set(allMeals.compactMap { Fmt.date($0["time"].str).map { cal.startOfDay(for: $0) } })
        return [today] + logged.filter { $0 < today }.sorted(by: >).prefix(6)
    }
    private var dayMeals: [JSON] {
        allMeals.filter { m in Fmt.date(m["time"].str).map { cal.isDate($0, inSameDayAs: selectedDay) } ?? false }
            .sorted { $0["time"].str < $1["time"].str }
    }
    private func total(_ key: String) -> Double { dayMeals.reduce(0) { $0 + $1[key].num } }

    /// Average daily kcal over the (up to) last 7 days that have any logged meal — same as the web card.
    private var weekAvg: (kcal: Int, days: Int)? {
        var byDay: [Date: Double] = [:]
        for m in allMeals { if let d = Fmt.date(m["time"].str) { byDay[cal.startOfDay(for: d), default: 0] += m["kcal"].num } }
        let recent = byDay.keys.sorted().suffix(7)
        guard !recent.isEmpty else { return nil }
        return (Int((recent.reduce(0) { $0 + byDay[$1]! } / Double(recent.count)).rounded()), recent.count)
    }
    private var workouts: [JSON] { app.data["workouts"].array.sorted { ($0["date"].str, $0["time"].str) > ($1["date"].str, $1["time"].str) } }

    var body: some View {
        Screen(title: "Salute", chat: .salute) {
            fatsecretBar
            #if os(macOS)
            Row([1, 2]) { nutritionCard; mealsCard }
            Row([2, 1]) { appleHealthCard; serverHealthCard }
            Row([2, 1]) { workoutsCard; trendCard }
            #else
            nutritionCard
            mealsCard
            appleHealthCard
            serverHealthCard
            workoutsCard
            trendCard
            #endif
        }
        .sheet(isPresented: $showMeal) { MealForm() }
        .sheet(isPresented: $showWorkout) { WorkoutForm() }
        .task { await loadTrend(force: false) }
        .onChange(of: app.data) { _, _ in syncedAt = Date() }
    }

    private func loadTrend(force: Bool) async {
        trendLoading = true; defer { trendLoading = false }
        do {
            trend = try await app.api.request("/api/lifeos-fitness-trend", query: force ? ["force": "1"] : [:])
            trendError = nil
        } catch { trendError = error.localizedDescription }
    }

    // MARK: FatSecret

    private var fatsecretBar: some View {
        let connected = app.data["fatsecretConnected"].bool
        return HStack(spacing: 8) {
            Circle().fill(connected ? T.green : T.text3).frame(width: 8, height: 8)
            if connected {
                Text("FatSecret · sincronizzato \(syncedAt.map { Fmt.it($0, "HH:mm") } ?? "—")").font(.footnote.weight(.semibold))
            } else {
                Text("FatSecret non collegato").font(.footnote.weight(.semibold))
                Spacer()
                Text("Collega da Profilo →").font(.footnote).foregroundStyle(T.accent)
            }
            if connected { Spacer() }
        }
        .foregroundStyle(T.text2)
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .adaptiveGlass(Capsule(), fallback: T.glassSoft)
    }

    private var dayChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chipDays, id: \.self) { d in
                    let on = cal.isDate(d, inSameDayAs: selectedDay)
                    Button { pickedDay = cal.isDate(d, inSameDayAs: today) ? nil : d } label: {
                        Text(cal.isDate(d, inSameDayAs: today) ? "Oggi" : cal.isDateInYesterday(d) ? "Ieri" : Fmt.it(d, "EEE d MMM").capitalized)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .adaptiveGlass(Capsule(), tint: on ? T.accent : nil, interactive: true, fallback: T.glassSoft)
                            .foregroundStyle(on ? Color.white : T.text2)
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    private var nutritionCard: some View {
        func row(_ label: String, _ key: String, _ unit: String, _ tint: Color) -> some View {
            let goal = max(targets[key].num, 1)
            return VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(label).font(.subheadline.weight(.semibold))
                    Spacer()
                    Text("\(Fmt.num(total(key))) / \(Fmt.num(goal)) \(unit)").font(.caption).foregroundStyle(T.text2).monospacedDigit()
                    Stepper("", onIncrement: { adjust(key, +(key == "kcal" ? 50 : 5)) }, onDecrement: { adjust(key, -(key == "kcal" ? 50 : 5)) })
                        .labelsHidden().scaleEffect(0.8).frame(width: 90)
                }
                ProgressBar(value: total(key) / goal, tint: tint)
            }
        }
        return Card {
            HStack { CardLabel("NUTRIZIONE"); Spacer() }
            dayChips
            HStack(spacing: 16) {
                ZStack {
                    Ring(value: total("kcal") / max(targets["kcal"].num, 1), lineWidth: 12)
                    VStack(spacing: 0) {
                        Text(Fmt.num(total("kcal"))).font(.title2.weight(.heavy)).monospacedDigit()
                        Text("kcal").font(.caption).foregroundStyle(T.text3)
                    }
                }.frame(width: 110, height: 110)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Restano").font(.caption).foregroundStyle(T.text3)
                    Text("\(Fmt.num(max(targets["kcal"].num - total("kcal"), 0))) kcal").font(.title3.weight(.bold))
                    Text("\(dayMeals.count) pasti registrati").font(.caption).foregroundStyle(T.text3)
                    if let w = weekAvg {
                        Text("Media \(w.days) giorni: \(w.kcal) kcal").font(.caption).foregroundStyle(T.text3)
                    }
                }
            }
            row("Calorie", "kcal", "kcal", T.accent)
            row("Proteine", "protein", "g", T.green)
            row("Carboidrati", "carbs", "g", T.amber)
            row("Grassi", "fat", "g", T.red)
        }
    }
    private func adjust(_ key: String, _ delta: Double) {
        Task { await app.saveSettings(["nutritionTargets": .object([key: .number(max(targets[key].num + delta, 0))])]) }
    }

    private var mealsCard: some View {
        Card {
            HStack {
                CardLabel(isToday ? "PASTI DI OGGI" : "PASTI · \(Fmt.it(selectedDay, "EEEE d MMMM").uppercased())"); Spacer()
                Button { showMeal = true } label: { Image(systemName: "plus.circle.fill").font(.title3) }
            }
            if dayMeals.isEmpty { Text("Nessun pasto registrato.").font(.subheadline).foregroundStyle(T.text3) }
            ForEach(dayMeals.indices, id: \.self) { i in
                let m = dayMeals[i]
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m["name"].str).font(.subheadline.weight(.semibold))
                        Text("\(Fmt.date(m["time"].str).map { Fmt.it($0, "HH:mm") } ?? "") · P \(Fmt.num(m["protein"].num))  C \(Fmt.num(m["carbs"].num))  G \(Fmt.num(m["fat"].num))")
                            .font(.caption).foregroundStyle(T.text3)
                        let serving = cleanServing(m["servingDescription"].str)
                        if !serving.isEmpty {
                            Text(serving).font(.caption2).foregroundStyle(T.text3).lineLimit(1)
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(Fmt.num(m["kcal"].num)) kcal").font(.subheadline.weight(.semibold)).monospacedDigit()
                        if m["source"].str == "fatsecret" {
                            Text("FatSecret").font(.caption2.weight(.semibold)).foregroundStyle(T.green)
                        }
                    }
                }
            }
        }
    }

    /// FatSecret custom servings arrive as "1 1/2 :custom:150s g Barilla" — drop the ":custom:150s" marker.
    private func cleanServing(_ s: String) -> String {
        s.replacingOccurrences(of: #"\s*:custom:\w+"#, with: "", options: .regularExpression)
    }

    // MARK: Apple Health

    private func hm(_ hours: Double) -> String { "\(Int(hours)) h \(Int((hours - Double(Int(hours))) * 60)) min" }

    private var appleHealthCard: some View {
        Card {
            HStack {
                CardLabel("APPLE SALUTE"); Spacer()
                if health.loading { ProgressView() }
                else if health.requested {
                    Button { Task { await health.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                }
            }
            if !health.available {
                Text("Apple Salute non è disponibile su questo dispositivo.").font(.subheadline).foregroundStyle(T.text3)
            } else if !health.requested {
                Text("Importa passi, calorie attive, sonno, peso e battito a riposo da Apple Salute.").font(.subheadline).foregroundStyle(T.text2)
                Button("Collega Apple Salute") { Task { await health.requestAccess() } }.buttonStyle(PillButtonStyle())
            } else if !health.hasAnyData {
                #if os(iOS)
                Text("Nessun dato letto. Se hai negato l'accesso, abilitalo da Impostazioni › Salute › Accesso ai dati › LifeOS.")
                    .font(.footnote).foregroundStyle(T.text3)
                #else
                Text("Nessun dato ancora: apri LifeOS sull'iPhone e collega Apple Salute, i dati arrivano qui da soli.")
                    .font(.footnote).foregroundStyle(T.text3)
                #endif
            } else {
                let lastSteps = health.steps.last?.value ?? 0
                let lastEnergy = health.activeEnergy.last?.value ?? 0
                let lastSleep = health.sleepHours.last
                HStack(alignment: .top) {
                    metric("Passi oggi", Fmt.num(lastSteps), "figure.walk")
                    metric("Kcal attive", Fmt.num(lastEnergy), "flame.fill")
                    metric("Sonno", lastSleep.map { hm($0.value) } ?? "—", "moon.fill")
                }
                HStack(alignment: .top) {
                    metric("Peso", health.weight.map { "\(Fmt.num($0, 1)) kg" } ?? "—", "scalemass.fill",
                           sub: weightDelta)
                    metric("FC a riposo", health.restingHR.map { "\(Fmt.num($0)) bpm" } ?? "—", "heart.fill")
                    Spacer().frame(maxWidth: .infinity)
                }
                if health.steps.contains(where: { $0.value > 0 }) { weekChart("PASSI · 7 GIORNI", health.steps, T.accent) }
                if health.sleepHours.count > 1 { weekChart("SONNO · ORE", health.sleepHours, T.green) }
            }
            if let e = health.error { Text(e).font(.caption).foregroundStyle(T.red) }
        }
    }

    private var weightDelta: String? {
        guard let w = health.weight, let p = health.weightPrev, abs(w - p) >= 0.05 else { return nil }
        return "\(w >= p ? "+" : "−")\(Fmt.num(abs(w - p), 1)) kg"
    }

    private func weekChart(_ title: String, _ values: [DayValue], _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption2.weight(.bold)).tracking(1).foregroundStyle(T.text3)
            Chart(values) { v in
                BarMark(x: .value("Giorno", v.day, unit: .day), y: .value("Valore", v.value))
                    .foregroundStyle(tint).cornerRadius(4)
            }
            .chartXAxis { AxisMarks(values: .stride(by: .day)) { _ in AxisValueLabel(format: .dateTime.weekday(.narrow)) } }
            .frame(height: 90)
        }
    }

    // Data the iOS Shortcut posted to the bridge (the old way) — kept for what Apple Salute doesn't have here.
    private var serverHealthCard: some View {
        let h = app.data["latestHealth"]
        return Group {
            if !h.isNull && !health.hasAnyData {
                Card {
                    CardLabel("ULTIMO IMPORT · \(h["date"].str)")
                    HStack {
                        metric("Sonno", h["sleepHours"].num > 0 ? "\(Fmt.num(h["sleepHours"].num, 1)) h" : "—", "moon.fill")
                        metric("Peso", h["weight"].num > 0 ? "\(Fmt.num(h["weight"].num, 1)) kg" : "—", "scalemass.fill")
                        if h["avgHr"].num > 0 { metric("FC media", "\(Fmt.num(h["avgHr"].num)) bpm", "heart.fill") }
                    }
                }
            }
        }
    }

    private func metric(_ l: String, _ v: String, _ icon: String, sub: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: icon).foregroundStyle(T.accent)
            Text(v).font(.headline.weight(.bold)).minimumScaleFactor(0.7).lineLimit(1)
            Text(l).font(.caption).foregroundStyle(T.text3)
            if let sub { Text(sub).font(.caption2.weight(.semibold)).foregroundStyle(T.text2) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var workoutsCard: some View {
        Card {
            HStack {
                CardLabel("ALLENAMENTI"); Spacer()
                Button { showWorkout = true } label: { Image(systemName: "plus.circle.fill").font(.title3) }
            }
            if workouts.isEmpty { Text("Nessun allenamento.").font(.subheadline).foregroundStyle(T.text3) }
            ForEach(workouts.prefix(10).indices, id: \.self) { i in
                let w = workouts[i]
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(w["title"].str).font(.subheadline.weight(.semibold))
                            Text("\(w["date"].str) · \(w["time"].str) · \(w["durationMinutes"].int) min · \(w["type"].str)").font(.caption).foregroundStyle(T.text3)
                        }
                        Spacer()
                        Button(role: .destructive) { Task { _ = await app.financeOp("workouts", "remove", id: w["id"].int) } } label: {
                            Image(systemName: "trash").font(.footnote).foregroundStyle(T.text3)
                        }.buttonStyle(.plain)
                    }
                    ForEach(w["exercises"].array.indices, id: \.self) { j in
                        let e = w["exercises"].array[j]
                        Text("• \(e["name"].str)\([e["sets"].str, e["load"].str].filter { !$0.isEmpty }.map { " · " + $0 }.joined())")
                            .font(.caption).foregroundStyle(T.text2)
                    }
                    if !w["notes"].str.isEmpty { Text(w["notes"].str).font(.caption).italic().foregroundStyle(T.text3) }
                }
            }
        }
    }

    private var trendCard: some View {
        Card {
            HStack {
                CardLabel("TREND IA"); Spacer()
                Button { Task { await loadTrend(force: true) } } label: {
                    if trendLoading { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                }
            }
            if let e = trendError { Text(e).font(.footnote).foregroundStyle(T.red) }
            ForEach(trend["lines"].strings, id: \.self) { l in
                HStack(alignment: .top, spacing: 8) {
                    Text("•").foregroundStyle(T.accent)
                    Text(l).font(.subheadline)
                }
            }
            if trend["lines"].array.isEmpty && trendError == nil && !trendLoading {
                Text("Nessun trend disponibile.").font(.subheadline).foregroundStyle(T.text3)
            }
        }
    }
}


// MARK: - Forms

struct MealForm: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [JSON] = []
    @State private var searching = false
    @State private var err: String?
    @State private var manualName = ""
    @State private var manualKcal = ""
    @State private var adding = false

    var body: some View {
        NavigationStack {
            ZStack {
                Backdrop()
                ScrollView {
                    VStack(spacing: 14) {
                        Card {
                            CardLabel("CERCA SU FATSECRET")
                            HStack {
                                Field(placeholder: "Es. petto di pollo", text: $query).onSubmit(search)
                                Button(action: search) { Image(systemName: "magnifyingglass") }.buttonStyle(PillButtonStyle())
                            }
                            if searching { ProgressView() }
                            ForEach(results.indices, id: \.self) { i in
                                let r = results[i]
                                Button { add(["foodId": r["id"]]) } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(r["brand"].str.isEmpty ? r["name"].str : "\(r["name"].str) (\(r["brand"].str))")
                                            .font(.subheadline.weight(.semibold)).multilineTextAlignment(.leading)
                                        if !r["description"].str.isEmpty { Text(r["description"].str).font(.caption).foregroundStyle(T.text3).multilineTextAlignment(.leading) }
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }.buttonStyle(.plain)
                                Divider().overlay(T.border)
                            }
                        }
                        Card {
                            CardLabel("INSERIMENTO MANUALE")
                            Field(placeholder: "Nome", text: $manualName)
                            Field(placeholder: "Calorie", text: $manualKcal, keyboard: .numberPad)
                            Button("Aggiungi") { add(["name": .string(manualName), "kcal": .number(Fmt.parse(manualKcal))]) }
                                .buttonStyle(PillButtonStyle()).disabled(manualName.isEmpty || Fmt.parse(manualKcal) <= 0)
                        }
                        if let err { Text(err).font(.footnote).foregroundStyle(T.red) }
                    }.padding(16)
                }
            }
            .navigationTitle("Aggiungi pasto").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { dismiss() } } }
            .disabled(adding)
        }
    }

    private func search() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        Task {
            searching = true; defer { searching = false }
            do {
                results = try await app.api.request("/api/lifeos-food-search", query: ["q": q])["results"].array
                err = nil
            } catch { err = error.localizedDescription }
        }
    }
    private func add(_ body: [String: JSON]) {
        Task {
            adding = true; defer { adding = false }
            if await app.mutate({ try await app.api.request("/api/lifeos-meal-add", method: "POST", body: .object(body)) }) != nil {
                dismiss()
            } else { err = app.error }
        }
    }
}

struct WorkoutForm: View {
    @EnvironmentObject var app: AppState
    struct Ex: Identifiable { let id = UUID(); var name = ""; var sets = ""; var load = "" }
    @State private var title = ""
    @State private var type = "Forza"
    @State private var date = Date()
    @State private var duration = "60"
    @State private var notes = ""
    @State private var exercises: [Ex] = [Ex()]
    var body: some View {
        FormShell(title: "Nuovo allenamento", canSave: !title.isEmpty) {
            let time = Fmt.it(date, "HH:mm")
            let ex: [JSON] = exercises.filter { !$0.name.isEmpty }.map { .object(["name": .string($0.name), "sets": .string($0.sets), "load": .string($0.load)]) }
            let r = await app.financeOp("workouts", "add", data: [
                "title": .string(title), "type": .string(type), "date": .string(Fmt.dayKey(date)), "time": .string(time),
                "durationMinutes": .number(Fmt.parse(duration)), "exercises": .array(ex), "notes": .string(notes),
            ])
            return r != nil
        } content: {
            Field(placeholder: "Titolo (es. Push day)", text: $title)
            Picker("Tipo", selection: $type) { ForEach(["Forza", "Cardio", "Mobilità"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
            DatePicker("Quando", selection: $date).foregroundStyle(T.text1)
            Field(placeholder: "Durata (min)", text: $duration, keyboard: .numberPad)
            ForEach($exercises) { $e in
                VStack(spacing: 6) {
                    Field(placeholder: "Esercizio", text: $e.name)
                    HStack { Field(placeholder: "Serie (4x8)", text: $e.sets); Field(placeholder: "Carico", text: $e.load) }
                }
            }
            Button("+ Esercizio") { exercises.append(Ex()) }.font(.footnote)
            Field(placeholder: "Note", text: $notes)
        }
    }
}
