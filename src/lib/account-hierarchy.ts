export interface AccountHierarchyNode {
  id: string;
  parentId: string | null;
}

/** Resolve descendants from an already organization-scoped account set. */
export function descendantAccountIds(
  accounts: readonly AccountHierarchyNode[],
  parentId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const account of accounts) {
    if (!account.parentId) continue;
    const children = childrenByParent.get(account.parentId) ?? [];
    children.push(account.id);
    childrenByParent.set(account.parentId, children);
  }

  const result: string[] = [];
  const visited = new Set<string>([parentId]);
  const stack = [...(childrenByParent.get(parentId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    result.push(current);
    stack.push(...(childrenByParent.get(current) ?? []));
  }

  return result;
}
