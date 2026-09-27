/**
 * Inbox v2 queries. The page, the /inbox switch, and the sidebar badge share these cache entries,
 * so the badge is always the list's own length — including while an approval is optimistically
 * removing a row.
 */
import { useQuery } from "@tanstack/react-query";
import { getInboxV2Enabled, listInboxV2 } from "@/routes/api/-inbox-v2";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";

/** The org's `inbox_v2` flag. Off while loading or on error: the classic Inbox is the default. */
export function useInboxV2Enabled(): { enabled: boolean; isPending: boolean } {
  const query = useQuery({
    queryKey: keys.inbox.v2Enabled(),
    queryFn: () => callServerFn(getInboxV2Enabled, { data: undefined }),
    staleTime: 60_000,
  });
  return { enabled: query.data?.enabled === true, isPending: query.isPending };
}

export function useInboxV2List(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: keys.inbox.v2List(),
    queryFn: () => callServerFn(listInboxV2, { data: undefined }),
    enabled: options.enabled ?? true,
    staleTime: 15_000,
  });
}

/** The sidebar's Inbox badge: how many items need a human. Nothing when the org is on v1. */
export function useInboxV2Badge(): number | string | undefined {
  const { enabled } = useInboxV2Enabled();
  const list = useInboxV2List({ enabled });
  if (!enabled || !list.data) return undefined;
  const count = list.data.items.length;
  return list.data.truncated ? `${count}+` : count;
}
