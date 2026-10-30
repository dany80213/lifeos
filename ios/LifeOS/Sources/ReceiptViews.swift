import SwiftUI
import PhotosUI
#if os(iOS)
import VisionKit
#endif

/// What the bridge could read from a receipt; anything unreadable stays empty and the user fills it in.
struct ReceiptPrefill {
    var merchant: String
    var date: Date?
    var total: Double?
    var category: String
    var usage: String
}

enum ReceiptPrep {
    /// Scales the long side to 1600 px and encodes a JPEG: enough to read the small print, light to upload.
    static func jpeg(from image: PlatformImage) -> Data? {
        let maxSide: CGFloat = 1600
        let scale = min(1, maxSide / max(image.size.width, image.size.height))
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        #if os(iOS)
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1
        let out = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return out.jpegData(compressionQuality: 0.7)
        #else
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        image.draw(in: CGRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7])
        #endif
    }
}

extension AppState {
    /// Sends the photo to the bridge, which reads it with Gemini. Saves nothing: the form that follows does.
    func scanReceipt(_ jpeg: Data) async throws -> ReceiptPrefill {
        let r = try await api.request("/api/lifeos-receipt-scan", method: "POST", body: ["data": .string(jpeg.base64EncodedString())])
        let u = r["usage"]
        let limit = u["limit"].isNull ? "" : " di \(u["limit"].int)"
        return ReceiptPrefill(
            merchant: r["merchant"].str,
            date: Fmt.date(r["date"].str),
            total: r["total"].isNull ? nil : r["total"].num,
            category: r["category"].str,
            usage: "Immagini lette oggi: \(u["count"].int)\(limit)"
        )
    }
}

#if os(iOS)
/// The system document scanner: finds the receipt's edges and straightens it.
struct ReceiptCamera: UIViewControllerRepresentable {
    var onImage: (UIImage) -> Void
    var onClose: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController()
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: VNDocumentCameraViewController, context: Context) {}
    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let parent: ReceiptCamera
        init(_ parent: ReceiptCamera) { self.parent = parent }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            parent.onClose()
            if scan.pageCount > 0 { parent.onImage(scan.imageOfPage(at: 0)) }
        }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { parent.onClose() }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { parent.onClose() }
    }
}
#endif

/// Photo → reading → the usual movement form, already filled in, to check and save.
struct ReceiptSheet: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) private var dismiss
    let accounts: [JSON]
    @State private var photoItem: PhotosPickerItem?
    @State private var camera = false
    @State private var reading = false
    @State private var failure: String?
    @State private var prefill: ReceiptPrefill?

    private var canScan: Bool {
        #if os(iOS)
        return VNDocumentCameraViewController.isSupported
        #else
        return false
        #endif
    }

    var body: some View {
        if let prefill {
            TxForm(accounts: accounts, prefill: prefill)
        } else {
            NavigationStack {
                ZStack {
                    Backdrop()
                    VStack(spacing: 12) {
                        if reading {
                            ProgressView()
                            Text("Sto leggendo lo scontrino…").font(.subheadline).foregroundStyle(T.text2)
                        } else {
                            if canScan {
                                Button { camera = true } label: { choice("Scatta una foto", "camera.fill") }.buttonStyle(.plain)
                            }
                            PhotosPicker(selection: $photoItem, matching: .images) { choice("Scegli dalla libreria", "photo.on.rectangle") }.buttonStyle(.plain)
                            if let failure {
                                Text(failure).font(.footnote).foregroundStyle(T.red).frame(maxWidth: .infinity, alignment: .leading)
                                Button("Inserisci a mano") { prefill = ReceiptPrefill(merchant: "", date: nil, total: nil, category: "", usage: "") }
                                    .font(.subheadline.weight(.semibold))
                            }
                            Text("La foto viene inviata a Google Gemini per la lettura e non viene salvata. Prima di registrare la spesa potrai controllare tutto.")
                                .font(.caption).foregroundStyle(T.text3).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }.padding(16)
                }
                .navigationTitle("Scontrino").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() } } }
            }
            .presentationDetents([.medium, .large])
            #if os(iOS)
            .fullScreenCover(isPresented: $camera) {
                ReceiptCamera(onImage: { read($0) }, onClose: { camera = false }).ignoresSafeArea()
            }
            #endif
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                Task {
                    photoItem = nil
                    guard let data = try? await item.loadTransferable(type: Data.self), let img = PlatformImage(imageData: data) else {
                        failure = "Non riesco ad aprire questa immagine."
                        return
                    }
                    read(img)
                }
            }
        }
    }

    private func choice(_ title: String, _ symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.title3).foregroundStyle(T.accent).frame(width: 30)
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(T.text1)
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(T.text3)
        }
        .padding(14).background(T.glass, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func read(_ image: PlatformImage) {
        guard let jpeg = ReceiptPrep.jpeg(from: image) else { failure = "Non riesco ad aprire questa immagine."; return }
        Task {
            reading = true; failure = nil
            do { prefill = try await app.scanReceipt(jpeg) }
            catch { failure = error.localizedDescription }
            reading = false
        }
    }
}
