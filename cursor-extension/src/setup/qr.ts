import qrcode = require("qrcode-generator");

/** An inline SVG QR code; no scripts, so it can go into a webview with scripts disabled. */
export function qrSvg(text: string, cellSize = 6): string {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 4 });
}
