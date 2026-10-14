import SwiftUI

struct ReviewView: View {
    @EnvironmentObject var app: AppState
    private var week: JSON { app.data["reviewWeek"] }

    var body: some View {
        Screen(title: "Review", chat: .review) {
            if week.isNull {
                Card { Text("Nessun dato per questa settimana.").foregroundStyle(T.text3) }
            } else {
                #if os(macOS)
                Row([1, 1, 1]) { summary; goodList; slippedList }
                #else
                summary
                goodList
                slippedList
                #endif
            }
            Card {
                CardLabel("RIEPILOGO CON L'IA")
                Text("Usa il pulsante ✦ in alto per chiedere a Jarvis di riassumere la settimana o confrontarla con le precedenti.")
                    .font(.subheadline).foregroundStyle(T.text2)
            }
        }
    }

    private var goodList: some View {
        list("COSA È ANDATO BENE", week["habits"].array.filter { $0["scheduledCount"].int > 0 && $0["doneCount"].int == $0["scheduledCount"].int }, good: true)
    }
    private var slippedList: some View {
        list("COSA È SLITTATO", week["habits"].array.filter { !$0["missedWeekdays"].array.isEmpty }, good: false)
    }

    private func range() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
        guard let a = f.date(from: week["startIso"].str), let b = f.date(from: week["endIso"].str) else { return "" }
        return "\(Fmt.it(a, "d MMM")) – \(Fmt.it(b, "d MMM"))"
    }

    private var summary: some View {
        let success = week["successDays"].num
        return Card {
            CardLabel("SETTIMANA")
            HStack(spacing: 18) {
                ZStack {
                    Ring(value: success / 7, lineWidth: 12)
                    VStack(spacing: 0) {
                        Text("\(week["successDays"].int)/7").font(.title2.weight(.heavy))
                        Text("giorni").font(.caption).foregroundStyle(T.text3)
                    }
                }.frame(width: 110, height: 110)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Settimana \(week["week"].int)").font(.title2.weight(.bold))
                    Text(range()).font(.subheadline).foregroundStyle(T.text2)
                    Text("\(week["daysElapsed"].int) giorni trascorsi").font(.caption).foregroundStyle(T.text3)
                }
            }
        }
    }

    private func list(_ title: String, _ rows: [JSON], good: Bool) -> some View {
        Card {
            CardLabel(title)
            if rows.isEmpty {
                Text(good ? "Ancora niente di completato al 100%." : "Nessuna abitudine mancata, ottimo!").font(.subheadline).foregroundStyle(T.text3)
            }
            ForEach(rows.indices, id: \.self) { i in
                let h = rows[i]
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Image(systemName: good ? "checkmark.circle.fill" : "exclamationmark.circle.fill").foregroundStyle(good ? T.green : T.amber)
                        Text(h["name"].str).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text("\(h["doneCount"].int)/\(h["scheduledCount"].int)").font(.subheadline).monospacedDigit().foregroundStyle(T.text2)
                    }
                    ProgressBar(value: h["scheduledCount"].num > 0 ? h["doneCount"].num / h["scheduledCount"].num : 0, tint: good ? T.green : T.amber)
                    if !good {
                        Text("Mancata: " + h["missedWeekdays"].strings.joined(separator: ", ")).font(.caption).foregroundStyle(T.text3)
                    }
                }
            }
        }
    }
}
