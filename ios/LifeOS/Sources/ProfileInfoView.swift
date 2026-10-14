import SwiftUI
import PhotosUI
#if os(iOS)
import ContactsUI
#endif

/// Round profile photo from settings.profile.photo (a data URL); initials when there is none.
struct ProfileAvatar: View {
    @EnvironmentObject var app: AppState
    var size: CGFloat = 56
    private var image: PlatformImage? {
        guard let s = app.settings["profile"]["photo"].string, let comma = s.firstIndex(of: ","),
              let data = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
        return PlatformImage(imageData: data)
    }
    private var initial: String {
        String((app.settings["profile"]["personal"]["nome"].string ?? "D").first ?? "D").uppercased()
    }
    var body: some View {
        Group {
            if let image {
                Image(platformImage: image).resizable().scaledToFill()
            } else {
                Text(initial).font(.system(size: size * 0.45, weight: .heavy)).foregroundStyle(.white)
                    .frame(width: size, height: size).background(T.accent)
            }
        }
        .frame(width: size, height: size).clipShape(Circle())
    }
}

enum PhotoPrep {
    /// Center-crops to a square, scales to 256 px and encodes as a small JPEG data URL (the server caps it at 250 KB).
    static func dataURL(from image: PlatformImage) -> String? {
        let side: CGFloat = 256
        let src = image.size
        let crop = min(src.width, src.height)
        let scale = side / crop
        let target = CGRect(x: -(src.width - crop) / 2 * scale, y: -(src.height - crop) / 2 * scale,
                            width: src.width * scale, height: src.height * scale)
        #if os(iOS)
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1
        let out = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: fmt).image { _ in image.draw(in: target) }
        guard let jpeg = out.jpegData(compressionQuality: 0.78) else { return nil }
        #else
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(side), pixelsHigh: Int(side), bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        image.draw(in: target)
        NSGraphicsContext.restoreGraphicsState()
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.78]) else { return nil }
        #endif
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }
}

#if os(iOS)
/// System contact picker (runs out of process: no Contacts permission needed). The user picks their own card.
struct ContactPicker: UIViewControllerRepresentable {
    var onPick: (CNContact) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }
    func makeUIViewController(context: Context) -> CNContactPickerViewController {
        let vc = CNContactPickerViewController()
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: CNContactPickerViewController, context: Context) {}
    final class Coordinator: NSObject, CNContactPickerDelegate {
        let onPick: (CNContact) -> Void
        init(onPick: @escaping (CNContact) -> Void) { self.onPick = onPick }
        func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) { onPick(contact) }
    }
}

#endif

struct ProfileInfoView: View {
    @EnvironmentObject var app: AppState
    @State private var nome = ""
    @State private var cognome = ""
    @State private var email = ""
    @State private var telefono = ""
    @State private var citta = ""
    @State private var nascita = ""
    @State private var ruolo = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var newPhoto: String?          // data URL chosen in this session, not saved yet
    @State private var removePhoto = false
    @State private var showContacts = false
    @State private var saving = false
    @State private var status = ""

    private var previewImage: PlatformImage? {
        guard let s = newPhoto, let comma = s.firstIndex(of: ","), let d = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
        return PlatformImage(imageData: d)
    }

    var body: some View {
        ZStack {
            Backdrop()
            ScrollView {
                VStack(spacing: 16) {
                    Card {
                        HStack(spacing: 16) {
                            Group {
                                if let previewImage {
                                    Image(platformImage: previewImage).resizable().scaledToFill().frame(width: 84, height: 84).clipShape(Circle())
                                } else if removePhoto {
                                    Text((nome.first.map(String.init) ?? "D").uppercased()).font(.system(size: 38, weight: .heavy)).foregroundStyle(.white)
                                        .frame(width: 84, height: 84).background(T.accent, in: Circle())
                                } else {
                                    ProfileAvatar(size: 84)
                                }
                            }
                            VStack(alignment: .leading, spacing: 8) {
                                PhotosPicker(selection: $photoItem, matching: .images) {
                                    Label("Scegli foto", systemImage: "photo")
                                }.font(.subheadline.weight(.semibold))
                                #if os(iOS)
                                Button { showContacts = true } label: { Label("Importa dalla mia scheda", systemImage: "person.crop.circle.badge.plus") }
                                    .font(.subheadline.weight(.semibold))
                                #endif
                                if previewImage != nil || app.settings["profile"]["photo"].string != nil, !removePhoto {
                                    Button("Rimuovi foto", role: .destructive) { newPhoto = nil; removePhoto = true }.font(.footnote)
                                }
                            }
                        }
                        Text("iOS non permette alle app di leggere in automatico la tua foto: scegline una dalla libreria o importala dalla tua scheda nei Contatti.")
                            .font(.caption).foregroundStyle(T.text3)
                    }
                    Card {
                        CardLabel("DATI PERSONALI")
                        Field(placeholder: "Nome", text: $nome)
                        Field(placeholder: "Cognome", text: $cognome)
                        Field(placeholder: "Email", text: $email, keyboard: .emailAddress)
                        Field(placeholder: "Telefono", text: $telefono, keyboard: .phonePad)
                        Field(placeholder: "Città", text: $citta)
                        Field(placeholder: "Data di nascita (gg/mm/aaaa)", text: $nascita)
                        Field(placeholder: "Ruolo", text: $ruolo)
                    }
                    HStack {
                        Button { Task { await save() } } label: {
                            HStack { if saving { ProgressView().tint(.white) }; Text("Salva e sincronizza") }.frame(maxWidth: .infinity)
                        }.buttonStyle(PillButtonStyle()).disabled(saving)
                    }
                    if !status.isEmpty { Text(status).font(.footnote).foregroundStyle(T.text2) }
                    Text("I dati vengono salvati sul tuo server e compaiono anche nella web app.").font(.caption).foregroundStyle(T.text3)
                }.padding(16)
            }
        }
        .navigationTitle("Il tuo profilo").navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: load)
        #if os(iOS)
        .sheet(isPresented: $showContacts) { ContactPicker { fill(from: $0); showContacts = false } }
        #endif
        .onChange(of: photoItem) { _, item in
            Task {
                guard let data = try? await item?.loadTransferable(type: Data.self), let img = PlatformImage(imageData: data) else { return }
                newPhoto = PhotoPrep.dataURL(from: img); removePhoto = false
            }
        }
    }

    private func load() {
        let p = app.settings["profile"]["personal"]
        nome = p["nome"].str; cognome = p["cognome"].str; email = p["email"].str; telefono = p["telefono"].str
        citta = p["citta"].str; nascita = p["nascita"].str; ruolo = p["ruolo"].str
    }

    #if os(iOS)
    private func fill(from c: CNContact) {
        if !c.givenName.isEmpty { nome = c.givenName }
        if !c.familyName.isEmpty { cognome = c.familyName }
        if let e = c.emailAddresses.first?.value as String? { email = e }
        if let t = c.phoneNumbers.first?.value.stringValue { telefono = t }
        if let city = c.postalAddresses.first?.value.city, !city.isEmpty { citta = city }
        if let b = c.birthday, let d = b.day, let m = b.month {
            nascita = String(format: "%02d/%02d", d, m) + (b.year.map { "/\($0)" } ?? "")
        }
        if !c.jobTitle.isEmpty { ruolo = c.jobTitle }
        if let data = c.imageData, let img = PlatformImage(imageData: data) { newPhoto = PhotoPrep.dataURL(from: img); removePhoto = false }
    }
    #endif

    private func save() async {
        saving = true; defer { saving = false }
        var fields: [String: JSON] = ["personal": .object([
            "nome": .string(nome), "cognome": .string(cognome), "email": .string(email), "telefono": .string(telefono),
            "citta": .string(citta), "nascita": .string(nascita), "ruolo": .string(ruolo),
        ])]
        if let newPhoto { fields["photo"] = .string(newPhoto) } else if removePhoto { fields["photo"] = .null }
        if await app.saveProfile(fields) {
            newPhoto = nil; removePhoto = false; status = "Salvato e sincronizzato con la web."
        } else { status = app.error ?? "Salvataggio non riuscito." }
    }
}
