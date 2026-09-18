import { useQuery } from "@tanstack/react-query";
import { keys } from "../lib/query-keys";
import { getAppConfig } from "../routes/api/-app-config";

type AppConfig = {
  inviteOnly: boolean;
  phTaxFilingEnabled: boolean;
};

/**
 * Client view of the Books product flag. Fail closed: until the config
 * resolves, BIR filing is treated as off so nav and EWT never flash.
 */
export function usePhTaxFilingEnabled(): { enabled: boolean; isPending: boolean } {
  const { data, isPending } = useQuery({
    queryKey: keys.appConfig.all(),
    queryFn: () => (getAppConfig as (opts: { data: unknown }) => Promise<AppConfig>)({ data: {} }),
    staleTime: 60_000,
  });
  return { enabled: data?.phTaxFilingEnabled === true, isPending };
}
