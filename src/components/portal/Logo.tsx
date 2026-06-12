import Image from "next/image"

interface LogoProps {
  size?: "sm" | "md" | "lg"
  showSubtitle?: boolean
  src?: string
  name?: string
  subtitle?: string
}

export function Logo({ size = "md", showSubtitle = false, src = "/logo.svg", name = "Portal", subtitle }: LogoProps) {
  const heights = { sm: 28, md: 38, lg: 50 }
  const widths = { sm: 130, md: 177, lg: 233 }
  const subSizes = { sm: "text-[9px]", md: "text-[11px]", lg: "text-[13px]" }
  const h = heights[size]
  const w = widths[size]

  return (
    <div className="flex flex-col items-start gap-0.5">
      <Image src={src} alt={name} width={w} height={h} priority style={{ width: w, height: "auto" }} />
      {showSubtitle && subtitle && (
        <span
          className={`${subSizes[size]} font-medium tracking-widest uppercase`}
          style={{ color: "var(--ink-soft)", letterSpacing: "0.18em" }}
        >
          {subtitle}
        </span>
      )}
    </div>
  )
}
