// Draws the Basic chart launcher icons: a glowing neon "BC" on black.
// Run from the "Basic chart android" folder:  swift tools/make-icons.swift
import AppKit

let res = "app/src/main/res"
let densities: [(String, CGFloat)] = [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)]

let background = NSColor(srgbRed: 0.02, green: 0.025, blue: 0.035, alpha: 1)
let glow = NSColor(srgbRed: 0.16, green: 0.62, blue: 1.0, alpha: 1)    // electric blue neon
let core = NSColor(srgbRed: 0.90, green: 0.97, blue: 1.0, alpha: 1)    // white-hot tube

enum Shape { case square, circle, none }

/// `textWidth` is the width of "BC" as a fraction of the canvas.
func render(px: Int, shape: Shape, textWidth: CGFloat) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                             colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(px)
  let rect = NSRect(x: 0, y: 0, width: s, height: s)
  NSColor.clear.setFill()
  rect.fill()

  switch shape {
  case .square:
    background.setFill()
    NSBezierPath(roundedRect: rect, xRadius: s * 0.18, yRadius: s * 0.18).fill()
  case .circle:
    background.setFill()
    NSBezierPath(ovalIn: rect).fill()
  case .none:
    break
  }

  // size the font so "BC" is textWidth of the canvas
  let font = NSFont(name: "ArialRoundedMTBold", size: 100) ?? NSFont.boldSystemFont(ofSize: 100)
  let probe = NSAttributedString(string: "BC", attributes: [.font: font])
  let fontSize = 100 * (s * textWidth) / probe.size().width
  let f = NSFont(name: font.fontName, size: fontSize)!
  let text = NSAttributedString(string: "BC", attributes: [.font: f, .foregroundColor: core, .kern: fontSize * 0.04])
  let ts = text.size()
  // centre on the cap height, not the line box
  let origin = NSPoint(x: (s - ts.width) / 2, y: (s - f.capHeight) / 2 + f.descender)

  // glow: several blurred passes in the neon colour, wide to tight, then the bright core on top
  // (blur as a fraction of the canvas, opacity, times drawn): stacking passes makes the glow bright
  let passes: [(CGFloat, CGFloat, Int)] = [(0.20, 1.0, 3), (0.10, 1.0, 3), (0.045, 1.0, 2), (0.015, 1.0, 2)]
  for (blur, alpha, times) in passes { for _ in 0..<times {
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = glow.withAlphaComponent(alpha)
    shadow.shadowBlurRadius = s * blur
    shadow.shadowOffset = .zero
    shadow.set()
    NSAttributedString(string: "BC", attributes: [.font: f, .foregroundColor: glow, .kern: fontSize * 0.04]).draw(at: origin)
    NSGraphicsContext.restoreGraphicsState()
  } }
  text.draw(at: origin)

  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

func write(_ data: Data, _ path: String) {
  let url = URL(fileURLWithPath: path)
  try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try! data.write(to: url)
}

for (name, scale) in densities {
  let dir = "\(res)/mipmap-\(name)"
  // legacy icons (Android 7): 48dp
  write(render(px: Int(48 * scale), shape: .square, textWidth: 0.62), "\(dir)/ic_launcher.png")
  write(render(px: Int(48 * scale), shape: .circle, textWidth: 0.58), "\(dir)/ic_launcher_round.png")
  // adaptive foreground (Android 8+): 108dp canvas, keep the letters inside the 66dp safe zone
  write(render(px: Int(108 * scale), shape: .none, textWidth: 0.50), "\(dir)/ic_launcher_foreground.png")
}
// large preview / store icon
write(render(px: 512, shape: .square, textWidth: 0.62), "tools/icon-preview.png")
print("icons written")
