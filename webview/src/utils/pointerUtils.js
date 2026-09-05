export const isPointerType = (type) => type.trim().endsWith('*');
export const shortenAddress = (addr) => addr.length > 8 ? addr.slice(0, 6) + '…' : addr;
export const isNullAddress = (addr) => addr === '0x0';
