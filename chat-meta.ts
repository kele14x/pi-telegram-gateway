/** Read both the original string values and structured cwd records. */
export function parseChatMeta(raw: string): Map<number, string> {
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Chat metadata must be an object");
  }
  const result = new Map<number, string>();
  for (const [key, value] of Object.entries(data)) {
    const id = Number(key);
    const cwd = typeof value === "string" ? value : value?.cwd;
    if (Number.isFinite(id) && typeof cwd === "string") result.set(id, cwd);
  }
  return result;
}

export function serializeChatMeta(meta: ReadonlyMap<number, string>): string {
  return JSON.stringify(Object.fromEntries([...meta].map(([id, cwd]) => [id, { cwd }])), null, 2);
}
