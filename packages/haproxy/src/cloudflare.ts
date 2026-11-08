import { BlockList, isIP } from "node:net";

/** Cloudflare's published proxy ranges (https://www.cloudflare.com/ips/). They change rarely; refresh from that page. */
export const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
export const CLOUDFLARE_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];
export const CLOUDFLARE_RANGES = [...CLOUDFLARE_V4, ...CLOUDFLARE_V6];

const list = new BlockList();
for (const cidr of CLOUDFLARE_RANGES) {
  const [net, bits] = cidr.split("/") as [string, string];
  list.addSubnet(net, Number(bits), net.includes(":") ? "ipv6" : "ipv4");
}

/** Whether an address belongs to Cloudflare's proxy network (so a hostname resolving to it is "orange-clouded"). */
export function isCloudflareIp(ip: string): boolean {
  const family = isIP(ip);
  return family !== 0 && list.check(ip, family === 4 ? "ipv4" : "ipv6");
}
