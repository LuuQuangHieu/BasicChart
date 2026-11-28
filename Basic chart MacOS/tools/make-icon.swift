// Draws the Basic chart Mac icon (a glowing neon "BC" on black) as an .iconset folder.
// Usage: swift tools/make-icon.swift <output.iconset>   (build.sh turns it into AppIcon.icns)
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
let background = NSColor(srgbRed: 0.02, green: 0.025, blue: 0.035, alpha: 1)
let glow = NSColor(srgbRed: 0.16, green: 0.62, blue: 1.0, alpha: 1)    // electric blue neon
let core = NSColor(srgbRed: 0.90, green: 0.97, blue: 1.0, alpha: 1)    // white-hot tube

func render(px: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                             colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(px)
  NSColor.clear.setFill()
  NSRect(x: 0, y: 0, width: s, height: s).fill()

  // macOS icon grid: an 824/1024 rounded square, centred, with a soft drop shadow
  let inset = s * 100 / 1024
  let tile = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
  NSGraphicsContext.saveGraphicsState()
  let drop = NSShadow()
  drop.shadowColor = NSColor.black.withAlphaComponent(0.35)
  drop.shadowBlurRadius = s * 0.02
  drop.shadowOffset = NSSize(width: 0, height: -s * 0.01)
  drop.set()
  background.setFill()
  let tilePath = NSBezierPath(roundedRect: tile, xRadius: s * 0.18, yRadius: s * 0.18)
  tilePath.fill()
  NSGraphicsContext.restoreGraphicsState()
  tilePath.addClip() // keep the glow inside the tile

  let probeFont = NSFont(name: "ArialRoundedMTBold", size: 100) ?? NSFont.boldSystemFont(ofSize: 100)
  let probe = NSAttributedString(string: "BC", attributes: [.font: probeFont])
  let fontSize = 100 * (tile.width * 0.62) / probe.size().width
  let f = NSFont(name: probeFont.fontName, size: fontSize)!
  let attrs: (NSColor) -> [NSAttributedString.Key: Any] = { [.font: f, .foregroundColor: $0, .kern: fontSize * 0.04] }
  let ts = NSAttributedString(string: "BC", attributes: attrs(core)).size()
  let origin = NSPoint(x: (s - ts.width) / 2, y: (s - f.capHeight) / 2 + f.descender)

  // glow: blurred passes in the neon colour, wide to tight, then the bright core on top
  let passes: [(CGFloat, Int)] = [(0.20, 3), (0.10, 3), (0.045, 2), (0.015, 2)]
  for (blur, times) in passes {
    for _ in 0..<times {
      NSGraphicsContext.saveGraphicsState()
      let shadow = NSShadow()
      shadow.shadowColor = glow
      shadow.shadowBlurRadius = tile.width * blur
      shadow.shadowOffset = .zero
      shadow.set()
      NSAttributedString(string: "BC", attributes: attrs(glow)).draw(at: origin)
      NSGraphicsContext.restoreGraphicsState()
    }
  }
  NSAttributedString(string: "BC", attributes: attrs(core)).draw(at: origin)

  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

try! FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
  try! render(px: size).write(to: URL(fileURLWithPath: "\(out)/icon_\(size)x\(size).png"))
  try! render(px: size * 2).write(to: URL(fileURLWithPath: "\(out)/icon_\(size)x\(size)@2x.png"))
}
