import { useSession } from "@/lib/auth-client";
import { getActiveOrganizationId } from "@/lib/auth-types";
import { useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/query-keys";

interface ActiveOrganization {
  id: string;
  name: string;
  slug: string | null;
  logoUrl?: string;
  currency?: string;
}

export function useActiveOrganization() {
  const { data: session, isPending: isSessionLoading } = useSession();
  const activeOrgId = getActiveOrganizationId(session);

  const { data: organizationData, isLoading: isOrgLoading } = useQuery({
    queryKey: keys.org.activeOrganization(activeOrgId),
    queryFn: async () => {
      if (!activeOrgId) return null;
      // Use the application's explicit safe projection. Better Auth's full-organization
      // response includes raw metadata and is therefore not a suitable browser API.
      const response = await fetch("/api/organization/active", {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Failed to load active organization");
      const org = (await response.json()) as ActiveOrganization;
      if (!org) return null;

      const result: ActiveOrganization = {
        id: org.id,
        name: org.name,
        slug: org.slug ?? null,
        logoUrl: org.logoUrl,
        currency: org.currency || "USD",
      };
      return result;
    },
    enabled: !!activeOrgId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  return {
    data: organizationData,
    isLoading: isSessionLoading || isOrgLoading,
    activeOrgId,
  };
}

export function useOrganizationCurrency(defaultCurrency: string = "USD") {
  const { data, isLoading, activeOrgId } = useActiveOrganization();

  return {
    activeOrgId,
    currency: data?.currency || defaultCurrency,
    isLoading,
  };
}
