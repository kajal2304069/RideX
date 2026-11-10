import { ReactNode, useState } from "react";
import { Pic, picSrcSet, picUrl } from "@/lib/images";
import { cn } from "@/lib/format";

/** A photo with a dark gradient for legible text on top, lazy loading, responsive sizes, and a graceful fallback. */
export function Photo({ pic, className, children, eager, sizes = "(min-width:1024px) 50vw, 100vw", position = "center" }: {
  pic: Pic; className?: string; children?: ReactNode; eager?: boolean; sizes?: string; position?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn("photo", className)}>
      {!failed && (
        <img src={picUrl(pic, 800)} srcSet={picSrcSet(pic)} sizes={sizes} alt={pic.alt} loading={eager ? "eager" : "lazy"} decoding="async"
          style={{ objectPosition: position }} onError={() => setFailed(true)} />
      )}
      {children}
    </div>
  );
}
