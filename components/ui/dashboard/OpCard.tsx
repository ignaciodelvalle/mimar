import type { ReactNode } from "react";

type AccentTone = "danger" | "warn" | undefined;

type CardProps = {
  children: ReactNode;
  /** Colored top border to draw attention (danger or warn). */
  accent?: AccentTone;
  className?: string;
};

type CardHeadProps = {
  /** Primary title text (rendered as an h3). */
  title: ReactNode;
  /** Optional right-side slot (e.g. a link or action button). */
  actions?: ReactNode;
};

type CardBodyProps = {
  children: ReactNode;
  className?: string;
};

const accentClasses: Record<NonNullable<AccentTone>, string> = {
  danger: "border-t-[3px] border-t-ln-op-danger",
  warn: "border-t-[3px] border-t-ln-op-warn",
};

/**
 * Container card — mimics .gob-card from the handoff.
 * Compose with OpCardHead + OpCardBody.
 *
 * @example
 * <OpCard accent="danger">
 *   <OpCardHead title="Outbox breach" actions={<a href="#">Ver →</a>} />
 *   <OpCardBody>…</OpCardBody>
 * </OpCard>
 */
export function OpCard({ children, accent, className = "" }: CardProps) {
  return (
    <div
      className={[
        "overflow-hidden rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card",
        accent ? accentClasses[accent] : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

/**
 * Card header row — title + optional right-side actions.
 * Mimics .gob-card-head from the handoff.
 */
export function OpCardHead({ title, actions }: CardHeadProps) {
  return (
    <div className="flex items-baseline gap-2 border-b border-ln-op-line-2 px-[15px] py-[11px]">
      <h3 className="m-0 font-ln-serif text-md font-semibold tracking-[-0.005em] text-ln-op-ink">
        {title}
      </h3>
      {actions && (
        <>
          <div className="flex-1" />
          <div className="text-sm font-semibold text-ln-op-azul">{actions}</div>
        </>
      )}
    </div>
  );
}

/**
 * Card body — padded content area.
 */
export function OpCardBody({ children, className = "" }: CardBodyProps) {
  return <div className={["p-[14px_16px]", className].filter(Boolean).join(" ")}>{children}</div>;
}
