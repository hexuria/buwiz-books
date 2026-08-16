import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { organization } from "@/lib/auth-client";
import { useOnClickOutside } from "usehooks-ts";
import { getCanCreateOrg } from "../routes/api/-app-config";
import { listAllOrganizations, adminSwitchOrg } from "../routes/api/-org-settings";
import { brand, brandInitial } from "@/config/brand";

interface OrganizationSwitcherProps {
  collapsed: boolean;
  activeOrg: { id: string; name: string; slug: string } | null;
}

export function OrganizationSwitcher({ collapsed, activeOrg }: OrganizationSwitcherProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [myOrgs, setMyOrgs] = useState<any[]>([]);
  const [allOrgs, setAllOrgs] = useState<any[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [search, setSearch] = useState("");
  const [canCreateOrg, setCanCreateOrg] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  useOnClickOutside(dropdownRef as React.RefObject<HTMLElement>, (e) => {
    if (buttonRef.current && buttonRef.current.contains(e.target as Node)) {
      return;
    }
    setIsOpen(false);
  });

  useEffect(() => {
    // Fetch the user's own orgs (via better-auth)
    organization.list().then((res) => {
      setMyOrgs((res as { data?: Array<{ id: string; name: string; slug: string }> })?.data ?? []);
    });

    // Fetch all orgs if user is admin
    (listAllOrganizations as (opts: { data: unknown }) => Promise<any>)({ data: {} }).then(
      (res) => {
        if (res?.isAdmin) {
          setIsAdmin(true);
          setAllOrgs(res.orgs ?? []);
        }
      },
    );

    (getCanCreateOrg as (opts: { data: unknown }) => Promise<{ canCreateOrg: boolean }>)({
      data: {},
    }).then((res) => setCanCreateOrg(res.canCreateOrg));
  }, []);

  // Update coordinates when opening
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setCoords({
        top: rect.bottom + 8,
        left: rect.left,
      });
    }
  }, [isOpen]);

  const handleSwitchOrg = async (orgId: string) => {
    // Check if user is already a member
    const isMember = myOrgs.some((o) => o.id === orgId);

    if (!isMember && isAdmin) {
      // Admin switching to an org they don't belong to — auto-create membership
      await (adminSwitchOrg as (opts: { data: unknown }) => Promise<any>)({
        data: { organizationId: orgId },
      });
    }

    // Clear all cached query data to prevent stale org data from persisting
    queryClient.clear();
    await organization.setActive({ organizationId: orgId });
    setIsOpen(false);
    window.location.reload();
  };

  const handleCreateOrg = () => {
    navigate({ to: "/create-organization" });
    setIsOpen(false);
  };

  // Build the filtered org list
  const matchesSearch = (org: any) =>
    org.name.toLowerCase().includes(search.toLowerCase()) ||
    (org.slug && org.slug.toLowerCase().includes(search.toLowerCase()));

  const myOrgIds = new Set(myOrgs.map((o) => o.id));
  const filteredMyOrgs = myOrgs.filter(matchesSearch);

  // "Other orgs" = all orgs the admin can see that they're NOT already a member of
  const filteredOtherOrgs = isAdmin
    ? allOrgs.filter((o) => !myOrgIds.has(o.id) && matchesSearch(o))
    : [];

  const orgInitial = activeOrg?.name?.charAt(0)?.toUpperCase() ?? brandInitial;

  // Styles
  const textPrimary = "text-[#1e293b] dark:text-white";
  const textSecondary = "text-[#64748b] dark:text-white/50";
  const hoverItemBg = "hover:bg-[#f1f5f9] dark:hover:bg-white/5";
  const dropdownBg = "bg-white dark:bg-[#1e293b]";
  const dropdownBorder = "border border-[#e2e8f0] dark:border-white/10";
  const shadow = "shadow-xl shadow-black/10 dark:shadow-black/30";

  const renderOrgItem = (org: any) => (
    <button
      key={org.id}
      onClick={() => handleSwitchOrg(org.id)}
      className={`w-full flex items-center gap-3 px-2 py-2 text-left text-[13px] rounded-lg transition-colors ${
        activeOrg?.id === org.id
          ? "bg-[#eff6ff] dark:bg-[#3b82f6]/10 text-[#3b82f6] dark:text-[#60a5fa]"
          : `${textPrimary} ${hoverItemBg}`
      }`}
    >
      <div
        className={`w-6 h-6 rounded flex items-center justify-center text-[11px] font-bold shrink-0 ${
          activeOrg?.id === org.id
            ? "bg-[#3b82f6] text-white"
            : "bg-[#e2e8f0] dark:bg-white/10 text-[#64748b] dark:text-white/60"
        }`}
      >
        {org.name.charAt(0).toUpperCase()}
      </div>
      <span className="truncate flex-1">{org.name}</span>
      {activeOrg?.id === org.id && (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </button>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-3 px-3 py-2 w-full text-left rounded-lg transition-colors ${hoverItemBg} outline-none focus:ring-2 focus:ring-[#6366f1]/20`}
        title={collapsed ? activeOrg?.name : "Switch organization"}
      >
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#3b82f6] to-[#6366f1] flex items-center justify-center text-white text-[13px] font-bold shrink-0 shadow-sm">
          {orgInitial}
        </div>

        {!collapsed && (
          <div className="flex-1 min-w-0 overflow-hidden">
            <div
              className={`text-[13px] font-semibold ${textPrimary} truncate flex items-center gap-1.5`}
            >
              {activeOrg?.name ?? brand.appName}
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`text-gray-400 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
            {activeOrg?.slug && (
              <div className={`text-[11px] ${textSecondary} truncate`}>@{activeOrg.slug}</div>
            )}
          </div>
        )}
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            className={`fixed z-[9999] w-[260px] ${dropdownBg} ${dropdownBorder} rounded-xl ${shadow} overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-top-left`}
            style={{ top: coords.top, left: coords.left }}
          >
            <div className="p-2">
              {/* Search Input */}
              <div className="mb-2 px-1 relative">
                <input
                  autoFocus
                  type="text"
                  placeholder="Find organization..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={`w-full bg-[#f8fafc] dark:bg-white/5 border border-[#e2e8f0] dark:border-white/10 rounded-lg px-3 py-1.5 pl-8 text-base sm:text-[12px] ${textPrimary} placeholder:${textSecondary} focus:outline-none focus:border-[#6366f1] focus:ring-1 focus:ring-[#6366f1] transition-all`}
                />
                <svg
                  className={`absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 ${textSecondary}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>

              {/* My Organizations */}
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[#94a3b8] dark:text-white/40">
                Personal
              </div>

              <div className="max-h-[200px] overflow-y-auto custom-scrollbar flex flex-col gap-0.5">
                {filteredMyOrgs.length === 0 && filteredOtherOrgs.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[12px] text-gray-400">
                    No organizations found
                  </div>
                ) : (
                  filteredMyOrgs.map(renderOrgItem)
                )}
              </div>

              {/* Admin: All Platform Organizations */}
              {filteredOtherOrgs.length > 0 && (
                <>
                  <div className={`h-px my-1.5 bg-[#e2e8f0] dark:bg-white/10`} />
                  <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[#94a3b8] dark:text-white/40 flex items-center gap-1.5">
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    All Organizations
                  </div>
                  <div className="max-h-[150px] overflow-y-auto custom-scrollbar flex flex-col gap-0.5">
                    {filteredOtherOrgs.map(renderOrgItem)}
                  </div>
                </>
              )}

              <div className={`h-px my-1.5 bg-[#e2e8f0] dark:bg-white/10`} />

              {canCreateOrg && (
                <button
                  onClick={handleCreateOrg}
                  className={`w-full flex items-center gap-3 px-2 py-2 text-left text-[13px] rounded-lg transition-colors ${textPrimary} ${hoverItemBg} group`}
                >
                  <div className="w-6 h-6 rounded border border-dashed border-[#94a3b8] dark:border-white/30 flex items-center justify-center text-[#94a3b8] dark:text-white/50 group-hover:border-[#6366f1] group-hover:text-[#6366f1] transition-colors bg-transparent shrink-0">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </div>
                  <span className="group-hover:text-[#6366f1] transition-colors">
                    Create Organization
                  </span>
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
