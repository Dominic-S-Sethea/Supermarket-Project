import type { ReactNode } from "react";

/**
 * Two-tone Editorial Vector page heading with the signature 4px violet
 * underline rule and optional status badge or subtitle.
 */
export function PageHeading({
  lead,
  accent,
  badge,
  subtitle,
  compact = false,
  icon,
}: {
  lead: string;
  accent: string;
  badge?: ReactNode;
  subtitle?: ReactNode;
  compact?: boolean;
  icon?: ReactNode;
}) {
  return (
    <div className={`editorial-heading-block ${compact ? "compact" : ""}`}>
      <div className="editorial-heading-row">
        {icon}
        <h1 className="editorial-heading">
          {lead} <span className="heading-accent">{accent}</span>
        </h1>
        {badge}
      </div>
      <div className="heading-rule" aria-hidden="true" />
      {subtitle && <p className="page-subtitle">{subtitle}</p>}
    </div>
  );
}
