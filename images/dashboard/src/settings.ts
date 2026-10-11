export const storageRoot = process.env.STORAGE_ROOT ?? "/mnt/storage";
export const arrayPrefix = process.env.ARRAY_PREFIX ?? "storage";
export const stateDirectory = `${storageRoot}/${arrayPrefix}-data1/.storage`;
export const statusDirectory = "/status";
export const publicDirectory = new URL("../public/", import.meta.url).pathname;
export const port = Number(process.env.PORT ?? 8080);
export const candidateTransports = (process.env.CANDIDATE_TRANSPORTS ?? "usb")
  .split(",")
  .map((transport) => transport.trim())
  .filter(Boolean);
export const roleLabelPattern = new RegExp(`^${arrayPrefix}-((data|parity)\\d+)$`);
