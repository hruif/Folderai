// On-device image analysis via Apple's Vision framework, for the file at argv[1].
// Prints JSON {"text": "...", "labels": ["dog","grass",...]} to stdout:
//  - text:   recognized text in the image (OCR) — screenshots, scans, receipts.
//  - labels: scene/object classification (what the image depicts) for text-less photos.
// Everything is local; no network, no data leaves the machine.
// Build:  swiftc -O ocr.swift -o ocr        Run:  ./ocr /path/to/image.png
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else { exit(2) }
guard let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    exit(1) // unreadable / not an image
}

var text = ""
var labels: [String] = []

let textRequest = VNRecognizeTextRequest { (request, _) in
    if let obs = request.results as? [VNRecognizedTextObservation] {
        text = obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    }
}
textRequest.recognitionLevel = .accurate
textRequest.usesLanguageCorrection = true

let classifyRequest = VNClassifyImageRequest { (request, _) in
    if let obs = request.results as? [VNClassificationObservation] {
        labels = obs.filter { $0.confidence > 0.3 }.prefix(6).map { $0.identifier }
    }
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([textRequest, classifyRequest]) // synchronous

let out: [String: Any] = ["text": text, "labels": labels]
if let data = try? JSONSerialization.data(withJSONObject: out),
   let s = String(data: data, encoding: .utf8) {
    print(s)
}
