import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { CopyButton, Dialog } from './primitives';

/** The dark modules of a link's QR code as one SVG path, in module units (error correction M, size picked by the length). */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return { size, d };
}

/**
 * A link as a QR code, for a phone to open: dark on white in both themes (phones read inverted codes
 * badly), with the 4-module quiet zone the standard asks for.
 */
export function QrCode({ text, px, label }: { text: string; px: number; label: string }) {
  const { size, d } = useMemo(() => qrPath(text), [text]);
  const box = size + 8;
  return (
    <svg className="qr" role="img" aria-label={label} width={px} height={px} viewBox={`-4 -4 ${box} ${box}`} shapeRendering="crispEdges">
      <rect x={-4} y={-4} width={box} height={box} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/** A small code in a table cell that opens the large one: a phone reads a small one only from close by. */
export function QrCell({ url, label, onOpen }: { url: string; label: string; onOpen: () => void }) {
  return (
    <button className="qr-cell" title={`${url}\nClick for a larger code`} onClick={onOpen}>
      <QrCode text={url} px={72} label={label} />
    </button>
  );
}

export function QrDialog({ title, url, note, onClose }: { title: string; url: string; note: string; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="qr-large">
        <QrCode text={url} px={280} label={`QR code of ${url}`} />
      </div>
      <p className="note">{note}</p>
      <div className="row"><span className="mono">{url}</span><CopyButton text={url} label="Copy the link" /></div>
    </Dialog>
  );
}
