/**
 * Locations Page — the shared dimension list screen, wired to the location server functions.
 *
 * The layout, tree, filters and side panel live in `DimensionListPage`; /departments renders the
 * same component with its own glyph, copy and API set.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  listLocations,
  getLocation,
  createLocation,
  updateLocation,
  deleteLocation,
  permanentlyDeleteLocation,
} from "./api/-dimensions";
import {
  DimensionListPage,
  type DimensionApi,
  type DimensionPageConfig,
  type DimensionSearch,
} from "../components/dimensions/DimensionListPage";

// ============================================================================
// Route Definition
// ============================================================================

export const Route = createFileRoute("/locations")({
  component: LocationsPage,
  validateSearch(search: Record<string, unknown>): DimensionSearch {
    return {
      selected: (search.selected as string) || undefined,
      mode: (search.mode as string) || undefined,
      status: (search.status as string) || undefined,
    };
  },
});

// ============================================================================
// Icons
// ============================================================================

function MapPinIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

// ============================================================================
// Page config
// ============================================================================

const config: DimensionPageConfig = {
  basePath: "/locations",
  detailPath: (id) => `/locations/${id}`,
  Icon: MapPinIcon,
  accentIcon: <MapPinIcon size={20} />,
  listQueryKey: ["locations"],
  detailQueryKey: (id) => ["location", id],
  api: {
    list: listLocations as DimensionApi["list"],
    get: getLocation as DimensionApi["get"],
    create: createLocation as DimensionApi["create"],
    update: updateLocation as DimensionApi["update"],
    deactivate: deleteLocation as DimensionApi["deactivate"],
    permanentlyDelete: permanentlyDeleteLocation as DimensionApi["permanentlyDelete"],
  },
  // The parent picker here lists records in the order the server returned them, not tree order.
  parentPickerOrder: "source",
  labels: {
    plural: "Locations",
    newEntity: "New Location",
    editEntity: "Edit Location",
    searchAriaLabel: "Lookup location",
    searchPlaceholder: "Lookup location…",
    columnHeader: "Location",
    errorLoading: "Error loading locations",
    emptySearch: "No locations match your search",
    emptyList: "No locations yet",
    addFirst: "Add your first location",
    addChild: "Add sub-location",
    editRow: "Edit location",
    viewRow: "View location",
    deactivateEntity: "Deactivate Location",
    reactivateEntity: "Reactivate Location",
    restoreEntity: "Restore Location",
    deleteEntity: "Delete Location",
    parentLabel: "Parent Location",
    nameLabel: "Location Name",
    namePlaceholder: "Enter location name",
    selectPrompt: "Select a location",
    selectHint: "Click on a location to view details or edit",
  },
};

// ============================================================================
// Page Component
// ============================================================================

function LocationsPage() {
  const search = Route.useSearch() as DimensionSearch;
  return <DimensionListPage config={config} search={search} />;
}
