// Face landmarks for tracing a new character, via Apple's Vision framework
// (runs on this Mac; nothing is uploaded).
//
//   swift tools/avatar/landmarks.swift <image> <out.json>
//
// Writes the largest face's box and landmark points in image pixels, origin
// top-left. build_avatar.py's `prepare` step turns them into a config.json.
import Vision
import AppKit

let args = CommandLine.arguments
let url = URL(fileURLWithPath: args[1])
guard let img = NSImage(contentsOf: url),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("cannot read image"); exit(1) }
let w = CGFloat(cg.width), h = CGFloat(cg.height)
let req = VNDetectFaceLandmarksRequest()
try VNImageRequestHandler(cgImage: cg).perform([req])
guard let face = (req.results ?? []).max(by: { $0.boundingBox.width < $1.boundingBox.width }),
      let lm = face.landmarks else { print("no face found"); exit(2) }

func pts(_ r: VNFaceLandmarkRegion2D?) -> [[Double]] {
  guard let r = r else { return [] }
  return r.pointsInImage(imageSize: CGSize(width: w, height: h)).map { [Double($0.x), Double(h - $0.y)] }
}
let b = face.boundingBox
var out: [String: Any] = [
  "size": [Int(w), Int(h)],
  "face": [Double(b.minX * w), Double((1 - b.maxY) * h), Double(b.width * w), Double(b.height * h)],
  "roll": face.roll?.doubleValue ?? 0,
  "yaw": face.yaw?.doubleValue ?? 0,
]
let regions: [String: VNFaceLandmarkRegion2D?] = [
  "leftEye": lm.leftEye, "rightEye": lm.rightEye, "leftPupil": lm.leftPupil, "rightPupil": lm.rightPupil,
  "outerLips": lm.outerLips, "innerLips": lm.innerLips, "faceContour": lm.faceContour, "nose": lm.nose,
  "leftEyebrow": lm.leftEyebrow, "rightEyebrow": lm.rightEyebrow,
]
for (k, v) in regions { out[k] = pts(v) }
let data = try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
try data.write(to: URL(fileURLWithPath: args[2]))
print("face at \(out["face"]!)")
