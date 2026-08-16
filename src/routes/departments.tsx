/**
 * Departments Page — the shared dimension list screen, wired to the department server functions.
 *
 * The layout, tree, filters and side panel live in `DimensionListPage`; /locations renders the
 * same component with its own glyph, copy and API set.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  permanentlyDeleteDepartment,
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

export const Route = createFileRoute("/departments")({
  component: DepartmentsPage,
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

function DeptIcon({ size = 20 }: { size?: number }) {
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
      <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
      <path d="M9 22v-4h6v4" />
      <path d="M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01" />
    </svg>
  );
}

// ============================================================================
// Page config
// ============================================================================

const config: DimensionPageConfig = {
  basePath: "/departments",
  detailPath: (id) => `/departments/${id}`,
  Icon: DeptIcon,
  // The accent band has always shown a table glyph here rather than the page's building glyph.
  accentIcon: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  ),
  listQueryKey: ["departments"],
  detailQueryKey: (id) => ["department", id],
  api: {
    list: listDepartments as DimensionApi["list"],
    get: getDepartment as DimensionApi["get"],
    create: createDepartment as DimensionApi["create"],
    update: updateDepartment as DimensionApi["update"],
    deactivate: deleteDepartment as DimensionApi["deactivate"],
    permanentlyDelete: permanentlyDeleteDepartment as DimensionApi["permanentlyDelete"],
  },
  parentPickerOrder: "hierarchy",
  labels: {
    plural: "Departments",
    newEntity: "New Department",
    editEntity: "Edit Department",
    searchAriaLabel: "Lookup department",
    searchPlaceholder: "Lookup department…",
    columnHeader: "Department",
    errorLoading: "Error loading departments",
    emptySearch: "No departments match your search",
    emptyList: "No departments yet",
    addFirst: "Add your first department",
    addChild: "Add child department",
    editRow: "Edit department",
    viewRow: "View department",
    deactivateEntity: "Deactivate Department",
    reactivateEntity: "Reactivate Department",
    restoreEntity: "Restore Department",
    deleteEntity: "Delete Department",
    parentLabel: "Parent Department",
    nameLabel: "Department Name",
    namePlaceholder: "Enter department name",
    selectPrompt: "Select a department",
    selectHint: "Click on a department to view details or edit",
  },
};

// ============================================================================
// Page Component
// ============================================================================

function DepartmentsPage() {
  const search = Route.useSearch() as DimensionSearch;
  return <DimensionListPage config={config} search={search} />;
}
