import { seriesSlot } from './colors';

/** Light-theme values of `--series-*` in styles.css (slot 0 = other); the icon is a file, not CSS. */
export const SERIES_HEX = ['#a5a49a', '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'] as const;

export const ICON_SIZE = 1024;

const escapeXml = (s: string): string => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The icon offered for an account's Safari web app: the devhost tile (`>_` on a rounded square)
 * in the account's color, with the account name underneath, so the Dock tells the logins apart.
 */
export function webAppIconSvg(allAccounts: readonly string[], account: string): string {
  const color = SERIES_HEX[seriesSlot(allAccounts, account)];
  // Account names are at most 32 characters; long ones shrink to fit the tile.
  const fontSize = Math.min(150, Math.floor(1500 / Math.max(account.length, 1)));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 1024 1024">`,
    `<rect x="100" y="100" width="824" height="824" rx="185" fill="${color}"/>`,
    `<path d="M300 300 L440 410 L300 520" fill="none" stroke="#fff" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path d="M500 520 H700" stroke="#fff" stroke-width="56" stroke-linecap="round"/>`,
    `<text x="512" y="780" text-anchor="middle" font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif" font-weight="600" font-size="${fontSize}" fill="#fff">${escapeXml(account)}</text>`,
    `</svg>`,
  ].join('');
}

/** Draw the SVG onto a canvas and encode it as PNG (what Safari's icon picker takes). Browser only. */
export async function rasterizeIcon(svg: string, size = ICON_SIZE): Promise<Uint8Array> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas available');
  ctx.drawImage(img, 0, 0, size, size);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('could not encode the icon as PNG');
  return new Uint8Array(await blob.arrayBuffer());
}
