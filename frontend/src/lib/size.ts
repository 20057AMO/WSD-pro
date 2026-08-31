/** Format a byte count as a human-readable binary size (KiB/MiB/GiB/TiB). */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  const digits = val >= 100 ? 0 : val >= 10 ? 1 : 2;
  return `${val.toFixed(digits)} ${units[i]}`;
}