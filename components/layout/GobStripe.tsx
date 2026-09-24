/**
 * Cinta argentina decorativa: dos bandas celeste con blanco en el medio.
 * Va arriba del header y/o abajo del footer.
 * Es puramente decorativa — aria-hidden.
 */

type Props = {
  /** Alto de la cinta en píxeles. Default 4px (fina, app moderna). */
  height?: number;
  className?: string;
};

export function GobStripe({ height = 4, className = "" }: Props) {
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        height: `${height}px`,
        background:
          // Tres bandas verticales iguales: celeste · blanco · celeste
          "linear-gradient(180deg, var(--color-ln-celeste) 0 33.333%, #ffffff 33.333% 66.666%, var(--color-ln-celeste) 66.666% 100%)",
      }}
    />
  );
}
