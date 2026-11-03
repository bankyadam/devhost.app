/** The one place that turns an ssh host spec (`user@name`) into names. */
export const sshHostName = (sshHost: string): string => sshHost.replace(/^.*@/, '');

/**
 * The name a dev server on the host can be reached under from this Mac: the Tailscale DNS name when
 * the host reports one (trailing dot removed), else the ssh host name.
 */
export const devServerHost = (sshHost: string, dnsName?: string | null): string => dnsName?.replace(/\.$/, '') || sshHostName(sshHost);

export const devServerUrl = (sshHost: string, dnsName: string | null | undefined, port: number): string => `http://${devServerHost(sshHost, dnsName)}:${port}`;
