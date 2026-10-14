import Foundation

struct DayValue: Identifiable { let id = UUID(); let day: Date; let value: Double }

#if os(iOS)
import HealthKit

/// Apple Health (HealthKit), read-only: steps, active energy, sleep, body weight, resting heart rate.
@MainActor
final class HealthStore: ObservableObject {
    @Published private(set) var available = HKHealthStore.isHealthDataAvailable()
    @Published private(set) var requested = UserDefaults.standard.bool(forKey: "lifeos_health_requested")
    @Published private(set) var loading = false
    @Published var error: String?

    @Published private(set) var steps: [DayValue] = []        // last 7 days, oldest first
    @Published private(set) var activeEnergy: [DayValue] = []
    @Published private(set) var sleepHours: [DayValue] = []   // one value per wake-up day
    @Published private(set) var weight: Double?
    @Published private(set) var weightPrev: Double?
    @Published private(set) var weightDate: Date?
    @Published private(set) var restingHR: Double?

    private let store = HKHealthStore()
    private let api = APIClient()
    private var readTypes: Set<HKObjectType> {
        var t = Set<HKObjectType>()
        for id in [HKQuantityTypeIdentifier.stepCount, .activeEnergyBurned, .bodyMass, .restingHeartRate] {
            if let q = HKQuantityType.quantityType(forIdentifier: id) { t.insert(q) }
        }
        if let s = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) { t.insert(s) }
        return t
    }

    var hasAnyData: Bool { !steps.isEmpty || !activeEnergy.isEmpty || !sleepHours.isEmpty || weight != nil || restingHR != nil }

    func start() async {
        guard available else { return }
        // HealthKit never reveals whether READ access was granted, so just query once it has been asked.
        // Re-asking is free: iOS only shows the sheet for types never asked before (e.g. steps / active energy
        // added after the first connect). Without this they stay "not determined" and HealthKit returns 0.
        if requested { try? await store.requestAuthorization(toShare: [], read: readTypes); await refresh() }
    }

    func requestAccess() async {
        guard available else { return }
        do {
            try await store.requestAuthorization(toShare: [], read: readTypes)
            UserDefaults.standard.set(true, forKey: "lifeos_health_requested")
            requested = true
            error = nil
        } catch { self.error = error.localizedDescription }
        await refresh()
    }

    func refresh() async {
        guard available, requested else { return }
        loading = true; defer { loading = false }
        async let st = daily(.stepCount, unit: .count())
        async let en = daily(.activeEnergyBurned, unit: .kilocalorie())
        async let sl = sleepByDay()
        async let wt = latestSamples(.bodyMass, unit: .gramUnit(with: .kilo), limit: 2)
        async let hr = latestSamples(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()), limit: 1)
        let (s, e, z, w, h) = await (st, en, sl, wt, hr)
        steps = s; activeEnergy = e; sleepHours = z
        weight = w.first?.value; weightPrev = w.count > 1 ? w[1].value : nil; weightDate = w.first?.date
        restingHR = h.first?.value
        print("[Salute] passi:", steps.map { "\(Fmt.dayKey($0.day))=\(Int($0.value))" }, "kcal:", activeEnergy.map { "\(Fmt.dayKey($0.day))=\(Int($0.value))" })
        await diagnoseActivity()
        await upload()
    }

    /// Steps / active energy all 0? Say why instead of showing a bare 0: HealthKit hides denied reads, but a
    /// sample query without date limits only returns something when read access is really granted.
    private func diagnoseActivity() async {
        for (id, name, label) in [(HKQuantityTypeIdentifier.stepCount, "Passi", "steps"), (.activeEnergyBurned, "Energia attiva", "activeEnergy")] {
            let values = label == "steps" ? steps : activeEnergy
            if values.contains(where: { $0.value > 0 }) { continue }
            let last = await latestSamples(id, unit: id == .stepCount ? .count() : .kilocalorie(), limit: 1).first
            if let last {
                error = "\(name): ultimo dato letto il \(last.date.formatted(date: .abbreviated, time: .shortened)), ma niente negli ultimi 7 giorni."
            } else {
                error = "\(name): Salute non restituisce nessun dato. Controlla Impostazioni › Salute › Accesso ai dati › LifeOS › \(name) (deve essere attivo) e che iPhone/Watch li registrino."
            }
            return
        }
    }

    /// HealthKit only exists on the iPhone: push what it just read to the bridge so the Mac app and the web
    /// show the same numbers (GET /api/lifeos-health).
    private func upload() async {
        var days: [String: [String: Double]] = [:]
        func put(_ list: [DayValue], _ key: String) { for v in list { days[Fmt.dayKey(v.day), default: [:]][key] = v.value } }
        // A 0 may just mean "no permission / no sample": never overwrite good server data with it.
        put(steps.filter { $0.value > 0 }, "steps"); put(activeEnergy.filter { $0.value > 0 }, "activeKcal"); put(sleepHours, "sleepHours")
        if let weight { days[Fmt.dayKey(weightDate ?? Date()), default: [:]]["weight"] = weight }
        if let restingHR { days[Fmt.dayKey(Date()), default: [:]]["restingHr"] = restingHR }
        guard !days.isEmpty else { return }
        let list: [JSON] = days.map { date, fields in
            var o: [String: JSON] = fields.mapValues { .number($0) }
            o["date"] = .string(date)
            return .object(o)
        }
        _ = try? await api.request("/api/lifeos-health", method: "POST", body: .object(["days": .array(list)]))
    }

    // MARK: queries

    private func daily(_ id: HKQuantityTypeIdentifier, unit: HKUnit) async -> [DayValue] {
        guard let type = HKQuantityType.quantityType(forIdentifier: id) else { return [] }
        let cal = Calendar.current
        let end = cal.startOfDay(for: Date()).addingTimeInterval(86_400)
        guard let start = cal.date(byAdding: .day, value: -7, to: end) else { return [] }
        return await withCheckedContinuation { cont in
            let q = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: HKQuery.predicateForSamples(withStart: start, end: end),
                options: .cumulativeSum, anchorDate: start, intervalComponents: DateComponents(day: 1))
            q.initialResultsHandler = { _, results, err in
                if let err { Task { @MainActor in self.error = "Apple Salute (\(id.rawValue)): \(err.localizedDescription)" } }
                var out: [DayValue] = []
                results?.enumerateStatistics(from: start, to: end) { stat, _ in
                    // The window ends at tomorrow's midnight: skip that empty bucket, or `.last` ("today") is always 0.
                    guard stat.startDate <= Date() else { return }
                    out.append(DayValue(day: stat.startDate, value: stat.sumQuantity()?.doubleValue(for: unit) ?? 0))
                }
                cont.resume(returning: Array(out.suffix(7)))
            }
            store.execute(q)
        }
    }

    private func latestSamples(_ id: HKQuantityTypeIdentifier, unit: HKUnit, limit: Int) async -> [(value: Double, date: Date)] {
        guard let type = HKQuantityType.quantityType(forIdentifier: id) else { return [] }
        return await withCheckedContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: nil, limit: limit,
                                  sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]) { _, samples, _ in
                let out = (samples as? [HKQuantitySample] ?? []).map { (value: $0.quantity.doubleValue(for: unit), date: $0.endDate) }
                cont.resume(returning: out)
            }
            store.execute(q)
        }
    }

    /// Hours asleep per wake-up day. Overlapping samples (watch + phone) are merged so nothing is counted twice.
    private func sleepByDay() async -> [DayValue] {
        guard let type = HKCategoryType.categoryType(forIdentifier: .sleepAnalysis) else { return [] }
        let cal = Calendar.current
        guard let start = cal.date(byAdding: .day, value: -8, to: cal.startOfDay(for: Date())) else { return [] }
        let asleep: Set<Int> = [
            HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue, HKCategoryValueSleepAnalysis.asleepCore.rawValue,
            HKCategoryValueSleepAnalysis.asleepDeep.rawValue, HKCategoryValueSleepAnalysis.asleepREM.rawValue,
        ]
        let intervals: [(Date, Date)] = await withCheckedContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: HKQuery.predicateForSamples(withStart: start, end: nil),
                                  limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                let out = (samples as? [HKCategorySample] ?? []).filter { asleep.contains($0.value) }.map { ($0.startDate, $0.endDate) }
                cont.resume(returning: out)
            }
            store.execute(q)
        }
        var buckets: [Date: [(Date, Date)]] = [:]
        for iv in intervals { buckets[cal.startOfDay(for: iv.1), default: []].append(iv) }
        return buckets.keys.sorted().suffix(7).map { day in
            var merged: [(Date, Date)] = []
            for iv in buckets[day]!.sorted(by: { $0.0 < $1.0 }) {
                if let last = merged.last, iv.0 <= last.1 { merged[merged.count - 1].1 = max(last.1, iv.1) }
                else { merged.append(iv) }
            }
            return DayValue(day: day, value: merged.reduce(0) { $0 + $1.1.timeIntervalSince($1.0) } / 3600)
        }
    }
}

#else

/// HealthKit is iPhone-only. The iPhone app uploads what it reads to the bridge; here the Mac reads the same
/// numbers back (GET /api/lifeos-health), so Salute shows identical data on every device.
@MainActor
final class HealthStore: ObservableObject {
    let available = true
    let requested = true
    @Published private(set) var loading = false
    @Published var error: String?
    @Published private(set) var steps: [DayValue] = []
    @Published private(set) var activeEnergy: [DayValue] = []
    @Published private(set) var sleepHours: [DayValue] = []
    @Published private(set) var weight: Double?
    @Published private(set) var weightPrev: Double?
    @Published private(set) var weightDate: Date?
    @Published private(set) var restingHR: Double?
    private let api = APIClient()

    var hasAnyData: Bool { !steps.isEmpty || !activeEnergy.isEmpty || !sleepHours.isEmpty || weight != nil || restingHR != nil }

    func start() async { await refresh() }
    func requestAccess() async { await refresh() }

    func refresh() async {
        loading = true; defer { loading = false }
        do {
            let r = try await api.request("/api/lifeos-health")
            let days = r["days"].array.suffix(7)
            func series(_ key: String) -> [DayValue] {
                days.compactMap { d in
                    guard let date = d["date"].string.flatMap(Fmt.date), d[key].double != nil else { return nil }
                    return DayValue(day: date, value: d[key].num)
                }
            }
            steps = series("steps"); activeEnergy = series("activeKcal"); sleepHours = series("sleepHours")
            let weights = r["days"].array.compactMap { d in d["weight"].double.map { (date: d["date"].str, value: $0) } }
            weight = weights.last?.value
            weightPrev = weights.count > 1 ? weights[weights.count - 2].value : nil
            weightDate = weights.last.flatMap { Fmt.date($0.date) }
            restingHR = r["latest"]["restingHr"].double
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

#endif
