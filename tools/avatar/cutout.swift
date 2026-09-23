// Background removal on this Mac with Apple's Vision framework (nothing is uploaded).
//
//   swift tools/avatar/cutout.swift <image> <out.png> [x y]
//
// With a point (image pixels, origin top-left, e.g. the middle of the face),
// only the foreground object under it is kept, so other things the model
// thinks are "foreground" (a car, a clothes rack) are dropped.
import Vision
import CoreImage
import AppKit

let args = CommandLine.arguments
let input = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[2])
let ci = CIImage(contentsOf: input)!
let handler = VNImageRequestHandler(ciImage: ci)
let req = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([req])
guard let result = req.results?.first else { print("no foreground"); exit(1) }

var instances = result.allInstances
if args.count >= 5, let px = Double(args[3]), let py = Double(args[4]) {
  let labels = result.instanceMask
  CVPixelBufferLockBaseAddress(labels, .readOnly)
  let lw = CVPixelBufferGetWidth(labels), lh = CVPixelBufferGetHeight(labels)
  let row = CVPixelBufferGetBytesPerRow(labels)
  let base = CVPixelBufferGetBaseAddress(labels)!.assumingMemoryBound(to: UInt8.self)
  let x = min(lw - 1, max(0, Int(px / Double(ci.extent.width) * Double(lw))))
  let y = min(lh - 1, max(0, Int(py / Double(ci.extent.height) * Double(lh))))
  let label = Int(base[y * row + x])
  CVPixelBufferUnlockBaseAddress(labels, .readOnly)
  if label > 0 { instances = IndexSet(integer: label) }
  print("instances: \(result.allInstances.count), keeping \(label)")
}
let mask = try result.generateScaledMaskForImage(forInstances: instances, from: handler)
let out = ci.applyingFilter("CIBlendWithMask", parameters: [
  kCIInputBackgroundImageKey: CIImage.empty(),
  kCIInputMaskImageKey: CIImage(cvPixelBuffer: mask)])
try CIContext().writePNGRepresentation(of: out, to: output, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
print("ok")
