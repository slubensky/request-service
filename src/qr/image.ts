/**
 * Server-side QR image rendering (see SDD.md §5, ARCHITECTURE.md).
 *
 * Emits an inline SVG so the QR embeds directly in the SSR HTML: no binary
 * asset to serve, no client JS, and crisp at any print size. `qrcode` is the
 * blueprint-sanctioned server-side QR dependency (justified in SDD §13); it is
 * never used on the client and requires no bundler.
 *
 * The encoded value is the public scan URL only -- an opaque token, never any
 * price, identity, or site structure.
 */
import QRCode from 'qrcode';

/**
 * Renders `data` (the public scan URL) as an inline SVG QR code. Medium error
 * correction balances density against resilience for a printed tag.
 */
export async function renderQrSvg(data: string): Promise<string> {
  return QRCode.toString(data, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
  });
}
