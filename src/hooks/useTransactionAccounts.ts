/**
 * Shared transaction-form account data. Both the "new transaction" and "transaction detail"
 * routes independently reimplemented this identical block (account tree query + flatten +
 * party-mapping overrides). Extracted here so the two ~1,800-line routes share one copy.
 *
 * Query keys are unchanged, so this is behavior-preserving — both routes hit the same cache.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { callServerFn } from "../lib/server-fn-client";
import { listAccounts, type AccountWithChildren } from "../routes/api/-accounts";
import { listPartyMappings } from "../routes/api/-party-mappings";
import type { PartyMappingOverride } from "../lib/party-scoping";
import type { AccountOption } from "../components/transactions/shared/types";
import { keys } from "../lib/query-keys";

export function useTransactionAccounts() {
  const { data: accountTree = [] } = useQuery({
    queryKey: keys.accounts.tree(),
    queryFn: () =>
      callServerFn(listAccounts, {
        data: { includeChildren: true, status: ["active"], types: [], subtypes: [] },
      }),
    structuralSharing: false,
  });

  const flatAccounts = useMemo(() => {
    const result: AccountOption[] = [];
    const flatten = (nodes: AccountWithChildren[]) => {
      for (const node of nodes) {
        result.push({
          id: node.id,
          name: node.name,
          accountNumber: node.accountNumber,
          accountType: node.accountType,
          subtype: node.subtype ?? null,
          icon: node.icon,
          parentId: node.parentId ?? null,
          readPartyTypes: node.readPartyTypes ?? null,
          mutatePartyTypes: node.mutatePartyTypes ?? null,
        });
        if (node.children?.length) flatten(node.children);
      }
    };
    flatten(accountTree);
    return result;
  }, [accountTree]);

  const { data: partyOverrides } = useQuery({
    queryKey: keys.parties.mappings(),
    queryFn: () => listPartyMappings(),
    staleTime: 5 * 60 * 1000,
  });
  const typedOverrides = partyOverrides as Record<string, PartyMappingOverride> | undefined;

  return { accountTree, flatAccounts, partyOverrides, typedOverrides };
}
