/** Where Homebrew lives: /opt/homebrew on Apple Silicon, /usr/local on Intel. */
export function homebrewPrefix(arch: string): string {
  return arch === 'arm64' ? '/opt/homebrew' : '/usr/local';
}
