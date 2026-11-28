#!/bin/bash
# Builds "build/Basic chart.app" (Apple silicon + Intel) and "build/Basic chart-macOS.zip".
# Needs Xcode (or the Command Line Tools) and Node.js. Run from anywhere: ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Basic chart.app"
MIN_OS=12.0

echo "• web app"
(cd .. && npm run build >/dev/null)

echo "• compile"
rm -rf build && mkdir -p build
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos$MIN_OS" Sources/main.swift -o "build/main-$arch"
done

echo "• bundle"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create build/main-arm64 build/main-x86_64 -output "$APP/Contents/MacOS/Basic chart"
cp Info.plist "$APP/Contents/Info.plist"
cp -R ../dist "$APP/Contents/Resources/web"

echo "• icon"
swift tools/make-icon.swift build/AppIcon.iconset
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"

echo "• sign (ad hoc)"
codesign --force --deep --sign - "$APP"

ditto -c -k --keepParent "$APP" "build/Basic chart-macOS.zip"
rm -rf build/main-* build/AppIcon.iconset
echo "done: $APP"
