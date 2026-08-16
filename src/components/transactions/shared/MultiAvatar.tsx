/**
 * MultiAvatar — Renders 1–5+ party avatars with layout variants.
 *
 * Layout rules:
 *   1 item  → single large circle (80×80 / 36×36 compact)
 *   2 items → two overlapping circles (56×56 / 30×30 compact)
 *   3 items → triangle: left-bottom, top-center, right-bottom (44×44 / 28×28 compact)
 *   4 items → 2×2 grid (40×40 / 24×24 compact)
 *   5+ items → same as 4, but slot 4 shows "+N" badge
 *
 * Z-order:
 *   3-item: left(lowest) → top → right(highest)
 *   4-item: slot3(lowest) → slot1 → slot2 → slot4(highest)
 *
 * Size prop:
 *   "lg" (default) — large header avatars (80px single circle)
 *   "sm" — compact header avatars (36px single circle)
 */

export interface AvatarItem {
  initials: string | null;
  /** Optional logo URL — if present, show image instead of initials */
  logoUrl?: string | null;
}

interface MultiAvatarProps {
  items: AvatarItem[];
  /** Fallback icon SVG path when no items (dangerouslySetInnerHTML) */
  fallbackIcon?: string;
  /** Overall size variant: "lg" (default) or "sm" (compact) */
  size?: "lg" | "sm";
}

/** Circle size classes keyed by [variant][circleSlot] */
const CIRCLE_SIZES: Record<string, Record<string, string>> = {
  lg: {
    xl: "w-20 h-20 text-3xl",
    lg: "w-14 h-14 text-lg",
    md: "w-11 h-11 text-sm",
    sm: "w-10 h-10 text-xs",
  },
  sm: {
    xl: "w-9 h-9 text-sm",
    lg: "w-7 h-7 text-[10px]",
    md: "w-6 h-6 text-[9px]",
    sm: "w-5 h-5 text-[8px]",
  },
};

/** Single avatar circle */
function Circle({
  item,
  circleSize,
  variant,
  className,
}: {
  item: AvatarItem | null;
  circleSize: string;
  variant: "lg" | "sm";
  className?: string;
}) {
  const cls = CIRCLE_SIZES[variant][circleSize] || CIRCLE_SIZES[variant].lg;
  const borderCls = variant === "sm" ? "border" : "border-2";

  return (
    <div
      className={`${cls} rounded-full flex items-center justify-center font-bold bg-white/20 text-white ${borderCls} border-white/30 ${className || ""}`}
    >
      {item?.logoUrl ? (
        <img src={item.logoUrl} alt="" className="w-full h-full rounded-full object-cover" />
      ) : (
        item?.initials || "?"
      )}
    </div>
  );
}

/** "+N" overflow badge circle */
function OverflowCircle({
  count,
  circleSize,
  variant,
  className,
}: {
  count: number;
  circleSize: string;
  variant: "lg" | "sm";
  className?: string;
}) {
  const cls = CIRCLE_SIZES[variant][circleSize] || CIRCLE_SIZES[variant].sm;
  const borderCls = variant === "sm" ? "border" : "border-2";

  return (
    <div
      className={`${cls} rounded-full flex items-center justify-center font-bold bg-white/30 text-white ${borderCls} border-white/30 ${className || ""}`}
    >
      +{count}
    </div>
  );
}

/** Container dimensions keyed by [variant] */
const CONTAINER_DIMS: Record<string, Record<string, { w: number; h: number }>> = {
  lg: { "3": { w: 72, h: 64 }, "4": { w: 68, h: 68 } },
  sm: { "3": { w: 36, h: 32 }, "4": { w: 34, h: 34 } },
};

export default function MultiAvatar({
  items,
  fallbackIcon,
  size: variant = "lg",
}: MultiAvatarProps) {
  const count = items.length;

  // No items → fallback icon
  if (count === 0) {
    const iconSize = variant === "sm" ? "16" : "32";
    const emptyClass = variant === "sm" ? "w-9 h-9" : "w-20 h-20";
    return (
      <div
        className={`${emptyClass} rounded-full border flex items-center justify-center shrink-0 bg-white/10 text-white/80`}
      >
        {fallbackIcon ? (
          <svg
            width={iconSize}
            height={iconSize}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            dangerouslySetInnerHTML={{ __html: fallbackIcon }}
          />
        ) : (
          <span className={variant === "sm" ? "text-sm" : "text-2xl"}>?</span>
        )}
      </div>
    );
  }

  // 1 item → single large circle
  if (count === 1) {
    return (
      <div className="shrink-0">
        <Circle item={items[0]} circleSize="xl" variant={variant} className="shadow-sm" />
      </div>
    );
  }

  // 2 items → overlapping horizontal pair
  if (count === 2) {
    const spacingClass = variant === "sm" ? "-space-x-1.5" : "-space-x-3";
    return (
      <div className={`flex items-center ${spacingClass} shrink-0`}>
        <Circle item={items[0]} circleSize="lg" variant={variant} className="z-[1]" />
        <Circle item={items[1]} circleSize="lg" variant={variant} className="z-[2]" />
      </div>
    );
  }

  // 3 items → triangle: left-bottom, top-center, right-bottom
  if (count === 3) {
    const dim = CONTAINER_DIMS[variant]["3"];
    return (
      <div className="relative shrink-0" style={{ width: dim.w, height: dim.h }}>
        {/* Left-bottom (lowest z) */}
        <div className="absolute bottom-0 left-0 z-[1]">
          <Circle item={items[0]} circleSize="md" variant={variant} />
        </div>
        {/* Top-center (middle z) */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 z-[2]">
          <Circle item={items[1]} circleSize="md" variant={variant} />
        </div>
        {/* Right-bottom (highest z) */}
        <div className="absolute bottom-0 right-0 z-[3]">
          <Circle item={items[2]} circleSize="md" variant={variant} />
        </div>
      </div>
    );
  }

  // 4+ items → 2×2 grid
  const overflow = count - 4;
  const showOverflow = overflow > 0;
  const dim = CONTAINER_DIMS[variant]["4"];

  return (
    <div className="relative shrink-0" style={{ width: dim.w, height: dim.h }}>
      {/* Slot 1: top-left (z-index 2) */}
      <div className="absolute top-0 left-0 z-[2]">
        <Circle item={items[0]} circleSize="sm" variant={variant} />
      </div>
      {/* Slot 2: top-right (z-index 3) */}
      <div className="absolute top-0 right-0 z-[3]">
        <Circle item={items[1]} circleSize="sm" variant={variant} />
      </div>
      {/* Slot 3: bottom-left (z-index 1, lowest) */}
      <div className="absolute bottom-0 left-0 z-[1]">
        <Circle item={items[2]} circleSize="sm" variant={variant} />
      </div>
      {/* Slot 4: bottom-right (z-index 4, highest) — overflow or avatar */}
      <div className="absolute bottom-0 right-0 z-[4]">
        {showOverflow ? (
          <OverflowCircle count={overflow + 1} circleSize="sm" variant={variant} />
        ) : (
          <Circle item={items[3]} circleSize="sm" variant={variant} />
        )}
      </div>
    </div>
  );
}
