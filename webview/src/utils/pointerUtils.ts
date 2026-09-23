export const isPointerType = (type: string): boolean => type.trim().endsWith('*');

/** Pointer check that also sees through typedefs (e.g. `nodePtr`) via the tracer's label. */
export const isPointerVar = (v: { type: string; type_label?: string }): boolean =>
  v.type_label ? v.type_label.startsWith('pointer to') : isPointerType(v.type);

export const shortenAddress = (addr: string): string =>
  addr.length > 8 ? addr.slice(0, 6) + '…' : addr;

export const isNullAddress = (addr: string): boolean => addr === '0x0';