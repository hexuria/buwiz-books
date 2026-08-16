/**
 * Vendors list page — thin wrapper over the shared EntityListPage.
 * All list/detail/create logic lives in components/parties/EntityListPage.tsx.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  EntityListPage,
  validateEntitySearch,
  type EntitySearch,
} from "../components/parties/EntityListPage";
import { ENTITY_CONFIGS } from "../components/parties/entity-configs";

export const Route = createFileRoute("/entities/vendors")({
  component: VendorsPage,
  validateSearch: validateEntitySearch,
});

function VendorsPage() {
  const search = Route.useSearch() as EntitySearch;
  const navigate = Route.useNavigate();
  return (
    <EntityListPage
      config={ENTITY_CONFIGS.vendor}
      search={search}
      navigate={(nextSearch) => navigate({ search: nextSearch })}
    />
  );
}
