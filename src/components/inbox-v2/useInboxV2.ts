/**
 * Inbox queries. The page and the sidebar badge share this cache entry, so the badge is always
 * the list's own length — including while an approval is optimistically removing a row.
 */
import { useQuery } from "@tanstack/react-query";
import { listInboxV2 } from "@/routes/api/-inbox-v2";
import { keys } from "@/lib/query-keys";
import { callServerFn } from "@/lib/server-fn-client";

export function useInboxV2List() {
  return useQuery({
    queryKey: keys.inbox.v2List(),
    queryFn: () => callServerFn(listInboxV2, { data: undefined }),
    staleTime: 15_000,
  });
}

/** The sidebar's Inbox badge: how many items need a human, with a plus past the list's ceiling. */
export function useInboxV2Badge(): number | string | undefined {
  const list = useInboxV2List();
  if (!list.data) return undefined;
  const count = list.data.items.length;
  return list.data.truncated ? `${count}+` : count;
}
