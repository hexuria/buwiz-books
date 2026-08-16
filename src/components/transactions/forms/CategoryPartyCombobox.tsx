/**
 * CategoryPartyCombobox — Category-scoped party combobox.
 * Used in Journal lines (per-line) and Transfer From/To.
 *
 * Resolves the subtype from the selected category (walking up the parent
 * chain if needed), then:
 *   - Uses getReadPartyTypes() for filtering the dropdown list
 *   - Uses getMutatePartyTypes() for the "Create …" label and action
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import Combobox from "../../ui/Combobox";
import type { ComboboxOption } from "../../ui/Combobox";
import type { AccountOption, CreatePartyFn, ListPartiesFn } from "../shared/types";
import { PARTY_ICON } from "../shared/constants";

import {
  getReadPartyTypes,
  getMutatePartyTypes,
  toPartyApiFilter,
} from "../../../lib/party-scoping";
import type { PartyType, PartyMappingOverride } from "../../../lib/party-scoping";

interface CategoryPartyComboboxProps {
  value: string;
  onChange: (value: string) => void;
  onNameChange?: (name: string) => void;
  categoryId: string;
  flatAccounts: AccountOption[];
  listPartiesFn: ListPartiesFn;
  createPartyFn?: CreatePartyFn;
  overrides?: Record<string, PartyMappingOverride>;
}

function useDebounce(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function CategoryPartyCombobox({
  value,
  onChange,
  onNameChange,
  categoryId,
  flatAccounts,
  listPartiesFn,
  createPartyFn,
  overrides,
}: CategoryPartyComboboxProps) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 200);
  const [options, setOptions] = useState<ComboboxOption[]>([]);

  // Resolve subtype for the selected category, walking the parent chain
  const resolvedSubtype = useMemo((): string | null => {
    if (!categoryId) return null;
    const acct = flatAccounts.find((a) => a.id === categoryId);
    if (!acct) return null;
    let subtype = acct.subtype ?? null;
    if (!subtype) {
      let parentAcct = flatAccounts.find((a) => a.id === acct.parentId);
      while (parentAcct && !subtype) {
        subtype = parentAcct.subtype ?? null;
        parentAcct = flatAccounts.find((a) => a.id === parentAcct!.parentId);
      }
    }
    return subtype;
  }, [categoryId, flatAccounts]);

  // Derive READ party types (for filtering dropdown) — Tier 1 uses array
  const readTypes = useMemo((): PartyType[] | null => {
    if (!categoryId) return null;
    const accountReadTypes = flatAccounts.find((a) => a.id === categoryId)?.readPartyTypes ?? null;
    const preferred = getReadPartyTypes(resolvedSubtype, "journal", overrides, accountReadTypes);
    return preferred.length > 0 ? preferred : null;
  }, [categoryId, resolvedSubtype, flatAccounts, overrides]);

  // Derive MUTATE party types (for the "Create …" button) — Tier 1 uses array
  const mutateTypes = useMemo((): PartyType[] | null => {
    if (!categoryId) return null;
    const accountMutateTypes =
      flatAccounts.find((a) => a.id === categoryId)?.mutatePartyTypes ?? null;
    const types = getMutatePartyTypes(resolvedSubtype, "journal", overrides, accountMutateTypes);
    return types.length > 0 ? types : null;
  }, [categoryId, resolvedSubtype, flatAccounts, overrides]);

  const readTypeFilter = useMemo(() => {
    if (!readTypes) return null;
    return toPartyApiFilter(readTypes);
  }, [readTypes]);

  // Fetch parties when category/query changes — using READ types, fallback to all parties
  useEffect(() => {
    // Skip only if no category AND no existing value to resolve
    if (!categoryId && !value) {
      setOptions([]);
      return;
    }
    let mounted = true;
    const fetchData: NonNullable<Parameters<ListPartiesFn>[0]>["data"] = {
      search: debouncedQuery,
      limit: 50,
    };
    // Apply type filter only when available (category has party mapping)
    if (readTypeFilter !== null) {
      fetchData.type = readTypeFilter;
    }
    listPartiesFn({ data: fetchData }).then((parties) => {
      if (!mounted) return;
      setOptions(
        parties.map((p) => ({
          value: p.id,
          label: p.name,
        })),
      );
      // Notify parent of name for the currently-selected value (resolves on mount)
      if (value && onNameChange) {
        const match = parties.find((p) => p.id === value);
        if (match) onNameChange(match.name);
      }
    });
    return () => {
      mounted = false;
    };
  }, [debouncedQuery, categoryId, value, readTypeFilter, listPartiesFn, onNameChange]);

  // Create handler — uses MUTATE types
  const handleCreate = useCallback(
    async (name: string) => {
      if (!createPartyFn || !mutateTypes?.length) return;
      const [partyType] = mutateTypes;
      if (!partyType) return;
      // If only one mutate type, auto-create with that type
      // If multiple, create with first type (future: could show picker)
      const newParty = await createPartyFn({
        data: { name, partyType },
      });
      if (newParty?.id) {
        onChange(newParty.id);
        setQuery("");
      }
    },
    [createPartyFn, mutateTypes, onChange],
  );

  // Create label uses MUTATE types (e.g. "bank" or "vendor or customer")
  const createLabel = mutateTypes?.length ? mutateTypes.join(" or ") : undefined;
  const hasCreate = !!(categoryId && createPartyFn && mutateTypes?.length);

  return (
    <Combobox
      value={value}
      onChange={(v) => {
        onChange(v);
        if (onNameChange) {
          const match = options.find((o) => o.value === v);
          if (match) onNameChange(match.label);
        }
      }}
      options={options}
      placeholder="Party"
      placeholderIcon={PARTY_ICON}
      searchPlaceholder="Find party..."
      onSearch={setQuery}
      onCreate={hasCreate ? handleCreate : undefined}
      createLabel={createLabel}
    />
  );
}
