/**
 * server-info.ts
 * Madar — Detect the host IP (LAN + Tailscale) used for UI links.
 */
import os from 'os';

export interface HostIps {
  lanIp: string | null;
  tailscaleIp: string | null;
}

function isTailscale(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts[0] !== 100) return false;
  return parts[1] >= 64 && parts[1] <= 127; // CGNAT 100.64.0.0/10
}

export function detectIp(): HostIps {
  let lanIp: string | null = null;
  let tailscaleIp: string | null = null;
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.internal || !String(a.family).startsWith('IPv4')) continue;
      const ip = a.address;
      if (isTailscale(ip)) {
        if (!tailscaleIp) tailscaleIp = ip;
      } else if (!lanIp) {
        lanIp = ip;
      }
    }
  }
  return { lanIp, tailscaleIp };
}