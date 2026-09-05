export const isPointerType = (type: string): boolean => type.trim().endsWith('*');

export const shortenAddress = (addr: string): string =>
  addr.length > 8 ? addr.slice(0, 6) + '…' : addr;

export const isNullAddress = (addr: string): boolean => addr === '0x0';