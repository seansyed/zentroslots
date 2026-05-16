// Bare layout for iframe-embedded booking widgets — no marketing nav,
// no top bar, no skip-link.
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
