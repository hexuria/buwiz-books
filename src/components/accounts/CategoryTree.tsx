import React, { useState } from "react";
import { CategoryRow, type AccountType } from "./CategoryRow";

// ============================================================================
// Types
// ============================================================================

export interface CategoryNode {
  id: string;
  name: string;
  accountNumber?: string | null;
  description?: string | null;
  accountType: AccountType;
  icon?: string | null;
  parentId?: string | null;
  children?: CategoryNode[];
  connections?: Array<{ name: string; logoUrl?: string }>;
}

interface CategoryTreeProps {
  categories: CategoryNode[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onEdit?: (id: string) => void;
  onAddChild?: (id: string) => void;
  onNavigate?: (id: string) => void;
  /** Offered in the empty state so a brand-new org has somewhere to start. */
  onUseTemplate?: () => void;
}

// ============================================================================
// Recursive Tree Renderer
// ============================================================================

interface TreeNodeProps {
  node: CategoryNode;
  level: number;
  expandedIds: Set<string>;
  selectedId?: string | null;
  onToggle: (id: string) => void;
  onSelect?: (id: string) => void;
  onEdit?: (id: string) => void;
  onAddChild?: (id: string) => void;
  onNavigate?: (id: string) => void;
}

const TreeNode: React.FC<TreeNodeProps> = ({
  node,
  level,
  expandedIds,
  selectedId,
  onToggle,
  onSelect,
  onEdit,
  onAddChild,
  onNavigate,
}) => {
  const isExpanded = expandedIds.has(node.id);
  const hasChildren = node.children && node.children.length > 0;

  return (
    <>
      <CategoryRow
        id={node.id}
        name={node.name}
        accountNumber={node.accountNumber}
        description={node.description}
        accountType={node.accountType}
        icon={node.icon}
        level={level}
        isSelected={selectedId === node.id}
        isExpanded={isExpanded}
        hasChildren={hasChildren}
        connections={node.connections}
        onClick={onSelect}
        onToggle={onToggle}
        onEdit={onEdit}
        onAddChild={onAddChild}
        onNavigate={onNavigate}
      />
      {isExpanded &&
        hasChildren &&
        node.children!.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            level={level + 1}
            expandedIds={expandedIds}
            selectedId={selectedId}
            onToggle={onToggle}
            onSelect={onSelect}
            onEdit={onEdit}
            onAddChild={onAddChild}
            onNavigate={onNavigate}
          />
        ))}
    </>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const CategoryTree: React.FC<CategoryTreeProps> = ({
  categories,
  selectedId,
  onSelect,
  onEdit,
  onAddChild,
  onNavigate,
  onUseTemplate,
}) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    // Auto-expand root nodes that have children
    const roots = new Set<string>();
    categories.forEach((cat) => {
      if (cat.children && cat.children.length > 0) {
        roots.add(cat.id);
      }
    });
    return roots;
  });

  const handleToggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="p-0 bg-white dark:bg-slate-900">
      {/* Column Headers */}
      {/* Connections is secondary and its header clipped at 375px in a 3/12 column, so below `sm`
          it yields its width to the category name and the row actions. The value is still on the
          category's own detail page. Spans must total 12 at each breakpoint. */}
      <div className="grid shrink-0 grid-cols-12 items-center border-b border-gray-200 px-3 py-2 text-xs font-medium tracking-wider text-[var(--color-app-text-light)] uppercase sm:px-4">
        <span className="col-span-9 sm:col-span-6">Category</span>
        <span className="hidden text-center sm:col-span-3 sm:block">Connections</span>
        <span className="col-span-3" />
      </div>

      {/* Tree Rows */}
      {categories.length > 0 ? (
        categories.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            level={0}
            expandedIds={expandedIds}
            selectedId={selectedId}
            onToggle={handleToggle}
            onSelect={onSelect}
            onEdit={onEdit}
            onAddChild={onAddChild}
            onNavigate={onNavigate}
          />
        ))
      ) : (
        <div className="flex flex-col items-center justify-center p-12 text-center text-[var(--color-app-text-light)]">
          <div className="text-5xl mb-4 opacity-50">📂</div>
          <div className="text-base mb-2">No categories found</div>
          <div className="text-sm opacity-75 mb-4">
            Start from a template to get a complete chart of accounts with every mapping filled in,
            or create categories one at a time.
          </div>
          {onUseTemplate && (
            <button
              type="button"
              onClick={onUseTemplate}
              className="px-4 py-2 text-sm font-semibold rounded-full bg-teal-600 text-white shadow-md shadow-teal-600/25 hover:bg-teal-700 transition-colors"
            >
              Start from a template
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default CategoryTree;
