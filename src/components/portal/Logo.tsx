import Image from "next/image"

interface LogoProps {
  size?: "sm" | "md" | "lg"
  showSubtitle?: boolean
}

export function Logo({ size = "md", showSubtitle = false }: LogoProps) {
  const heights = { sm: 28, md: 38, lg: 50 }
  const widths = { sm: 130, md: 177, lg: 233 }
  const subSizes = { sm: "text-[9px]", md: "text-[11px]", lg: "text-[13px]" }
  const h = heights[size]
  const w = widths[size]

  return (
    <div className="flex flex-col items-start gap-0.5">
      <Image src="/logo.svg" alt="Central LED" width={w} height={h} priority />
      {showSubtitle && (
        <span
          className={`${subSizes[size]} font-medium tracking-widest uppercase`}
          style={{ color: "var(--ink-soft)", letterSpacing: "0.18em" }}
        >
          Materiales Eléctricos e Iluminación
        </span>
      )}
    </div>
  )
}
